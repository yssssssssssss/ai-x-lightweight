import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ReadableExecutionPlan,
  NativeSkillResult,
} from '../../../../packages/api-contract/native-skill-orchestration.ts';
import type { ControlFinalReport } from '../../../../packages/api-contract/historical-final-report.ts';
import {
  api,
  type ClarificationRequiredResponse,
  type ClarifyControlTaskRequest,
  type ControlApprovalRequirement,
  type ControlExecutionResult,
  type ControlPlanRecovery,
  type ControlPlanCandidatesResponse,
  type CurrentTaskReadResponse,
  type CurrentPlanCandidate,
  type ExecLogRow,
  type OrchestrationModeV1,
  type PlanProgress,
  type PlanResponse,
  type TaskFollowUpMessageV1,
  type DatasetUpload,
  type DocumentUpload,
  type VisualUpload,
} from '../api/client.ts';
import {
  approvalSubmissionAllowed,
  beginClarificationSubmission,
  buildConfirmationAnswers,
  createClarificationSubmissionState,
  createRequestId,
  currentExecutionGapCount,
  executionPlanStepsForTask,
  executionStepsToExecLog,
  hydrateCurrentTask,
  selectAuthoritativeFailedStep,
  settleClarificationSubmission,
  type ConfirmationRequirement,
  type ExecutionPlanStepView,
  type ReportState,
} from '../current-flow-state.ts';
import { taskIdFromLocationSearch } from '../task-link.ts';

const CURRENT_TASK_STORAGE_KEY = 'ur_current_task_id';

// Current 同页状态机；Legacy 任务只在 Workbench 历史详情中只读展示。
export type Phase =
  | 'idle'
  | 'loading-task'
  | 'planning'
  | 'clarifying'
  | 'picking'
  | 'selecting'
  | 'planned'
  | 'awaiting-approval'
  | 'ready'
  | 'executing'
  | 'paused'
  | 'reviewing'
  | 'composing-report'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'rejected'
  | 'error';

const AUTO_REFRESH_PHASES = new Set<Phase>([
  'awaiting-approval',
  'executing',
  'reviewing',
  'composing-report',
]);
const INITIAL_POLL_DELAY_MS = 2_000;
const MAX_POLL_DELAY_MS = 16_000;
const INTAKE_UPLOAD_CONCURRENCY = 3;

interface CachedIntakeUpload {
  files: readonly File[];
  metadata: string | null;
  inputId: string;
}

interface CachedIntakeConfirmation {
  planVersionId: string;
  signature: string;
  idempotencyKey: string;
}

function sortedRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function sameFiles(left: readonly File[], right: readonly File[]): boolean {
  return left.length === right.length && left.every((file, index) => file === right[index]);
}

async function runIntakeUploads(operations: Array<() => Promise<void>>): Promise<void> {
  let cursor = 0;
  const errors: unknown[] = [];
  async function worker(): Promise<void> {
    while (cursor < operations.length) {
      const operation = operations[cursor];
      cursor += 1;
      if (!operation) return;
      try {
        await operation();
      } catch (error) {
        errors.push(error);
      }
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(INTAKE_UPLOAD_CONCURRENCY, operations.length) },
    () => worker(),
  ));
  if (errors.length > 0) throw errors[0];
}

function planView(
  response: ControlPlanCandidatesResponse,
  candidate: CurrentPlanCandidate,
): PlanResponse {
  const readablePlan = candidate.plan as ReadableExecutionPlan;
  return {
    conversationId: response.conversationId,
    taskId: response.task.id,
    task: response.structuredTask,
    activatedNodes: response.activatedNodes,
    plan: {
      steps: candidate.plan.steps,
      activated_nodes: response.activatedNodes,
      assumptions: response.structuredTask.assumptions,
      ...(readablePlan.execution_contract_version
        ? { execution_contract_version: readablePlan.execution_contract_version }
        : {}),
      ...('mode' in readablePlan ? { mode: readablePlan.mode } : {}),
      ...(readablePlan.skill_invocations
        ? { skill_invocations: readablePlan.skill_invocations }
        : {}),
      ...('resolved_inputs' in readablePlan
        ? { resolved_inputs: readablePlan.resolved_inputs }
        : {}),
      ...('capability_demand_graph' in readablePlan
        ? { capability_demand_graph: readablePlan.capability_demand_graph }
        : {}),
      ...('contribution_requirements' in readablePlan
        ? { contribution_requirements: readablePlan.contribution_requirements }
        : {}),
      ...('portfolio_summary' in readablePlan
        ? { portfolio_summary: readablePlan.portfolio_summary }
        : {}),
      ...(readablePlan.capability_gaps
        ? { capability_gaps: readablePlan.capability_gaps }
        : {}),
    },
    pendingUploads: candidate.pendingInputs,
  };
}

function confirmationRequirements(confirmations: unknown[]): ConfirmationRequirement[] {
  return confirmations.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const candidate = value as { key?: unknown; question?: unknown; suggestion?: unknown };
    if (typeof candidate.key !== 'string' || candidate.key.trim() === '') return [];
    return [{
      key: candidate.key,
      question: typeof candidate.question === 'string' ? candidate.question : undefined,
      suggestion: candidate.suggestion,
    }];
  });
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function upsertPlanningProgress(
  previous: PlanProgress[],
  event: PlanProgress,
): PlanProgress[] {
  const index = previous.findIndex((item) => item.phase === event.phase);
  if (index < 0) return [...previous, event];
  const next = [...previous];
  next[index] = event;
  return next;
}

export function useTaskFlow() {
  const [clarification, setClarification] = useState<ClarificationRequiredResponse | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [candidatesResp, setCandidatesResp] = useState<ControlPlanCandidatesResponse | null>(null);
  const [selectedCandidate, setSelectedCandidate] = useState<CurrentPlanCandidate | null>(null);
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [currentTaskId, setCurrentTaskId] = useState<string | null>(null);
  const [stateVersion, setStateVersion] = useState<number | null>(null);
  const [originalInput, setOriginalInput] = useState('');
  const [orchestrationMode, setOrchestrationMode] = useState<OrchestrationModeV1 | null>(null);
  const [exec, setExec] = useState<ControlExecutionResult | null>(null);
  const [executionSteps, setExecutionSteps] = useState<ExecLogRow[]>([]);
  const [executionPlanSteps, setExecutionPlanSteps] = useState<ExecutionPlanStepView[]>([]);
  const [finalReport, setFinalReport] = useState<ControlFinalReport | null>(null);
  const [skillResults, setSkillResults] = useState<NativeSkillResult[]>([]);
  const [reportState, setReportState] = useState<ReportState>('idle');
  const [deliverableError, setDeliverableError] = useState('');
  const [followUpMessages, setFollowUpMessages] = useState<TaskFollowUpMessageV1[]>([]);
  const [followUpLoading, setFollowUpLoading] = useState(false);
  const [followUpSubmitting, setFollowUpSubmitting] = useState(false);
  const [followUpError, setFollowUpError] = useState('');
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<PlanProgress[]>([]);
  const [approvalRequirements, setApprovalRequirements] = useState<ControlApprovalRequirement[]>([]);
  const [approvalSubmitting, setApprovalSubmitting] = useState(false);
  const [planRecovery, setPlanRecovery] = useState<ControlPlanRecovery | null>(null);
  const [revisionSubmitting, setRevisionSubmitting] = useState(false);
  const [cancelSubmitting, setCancelSubmitting] = useState(false);
  const clarificationSubmission = useRef(createClarificationSubmissionState());
  const intakeUploadCache = useRef(new Map<string, CachedIntakeUpload>());
  const intakeConfirmation = useRef<CachedIntakeConfirmation | null>(null);
  const restoreGeneration = useRef(0);
  const [clarificationSubmitting, setClarificationSubmitting] = useState(false);

  async function refreshExecutionSteps(taskId: string): Promise<void> {
    const current = await api.controlTask(taskId);
    setStateVersion(current.task.stateVersion);
    setExecutionSteps(executionStepsToExecLog(current.executionSteps));
    setExecutionPlanSteps(executionPlanStepsForTask(current));
  }

  const loadTaskFollowUps = useCallback(async (
    taskId: string,
    generation?: number,
  ): Promise<void> => {
    setFollowUpLoading(true);
    setFollowUpError('');
    try {
      const response = await api.controlFollowUps(taskId);
      if (generation !== undefined && generation !== restoreGeneration.current) return;
      setFollowUpMessages(response.messages);
    } catch (cause) {
      if (generation !== undefined && generation !== restoreGeneration.current) return;
      setFollowUpError(message(cause, '报告追问记录加载失败'));
    } finally {
      if (generation === undefined || generation === restoreGeneration.current) {
        setFollowUpLoading(false);
      }
    }
  }, []);

  async function loadDeliverable(taskId: string): Promise<void> {
    setReportState('loading');
    setDeliverableError('');
    try {
      const [loadedFinalReport, loadedSkillResults] = await Promise.all([
        api.controlFinalReport(taskId),
        api.controlSkillResults(taskId),
      ]);
      setFinalReport(loadedFinalReport);
      setSkillResults(loadedSkillResults.results);
      setReportState('ready');
      await loadTaskFollowUps(taskId);
    } catch (cause) {
      setDeliverableError(message(cause, '报告加载失败'));
      setReportState('report-loading-error');
    }
  }

  const applyCurrentTask = useCallback(async (
    current: CurrentTaskReadResponse,
    generation: number,
  ): Promise<void> => {
    const hydrated = hydrateCurrentTask(current);
    if (generation !== restoreGeneration.current) return;

    const restoredSteps = executionStepsToExecLog(current.executionSteps);
    const selected = hydrated.selectedCandidate;
    setOriginalInput(hydrated.originalInput);
    setOrchestrationMode(
      current.task.orchestrationMode
      ?? (selected && 'capability_demand_graph' in selected.plan
        ? 'multi_skill'
        : 'single_skill'),
    );
    setStateVersion(hydrated.stateVersion);
    setClarification(hydrated.clarification as ClarificationRequiredResponse | null);
    setCandidatesResp(hydrated.candidatesResp);
    setSelectedCandidate(selected);
    setPlan(selected && hydrated.candidatesResp ? planView(hydrated.candidatesResp, selected) : null);
    setExecutionSteps(restoredSteps);
    setExecutionPlanSteps(executionPlanStepsForTask(current));
    setFinalReport(null);
    setSkillResults([]);
    setFollowUpMessages([]);
    setFollowUpLoading(false);
    setFollowUpSubmitting(false);
    setFollowUpError('');
    setReportState('idle');
    setDeliverableError('');
    setError('');
    setProgress([]);
    setApprovalRequirements(current.approvalRequirements ?? []);
    setPlanRecovery(current.planRecovery ?? null);

    const { state, stateVersion: restoredStateVersion, currentAttemptId } = current.task;
    if (hydrated.phase === 'paused') {
      const failedStep = selectAuthoritativeFailedStep(current.executionSteps);
      setExec({
        attemptId: currentAttemptId!,
        state,
        stateVersion: restoredStateVersion,
        status: 'paused',
        executionDisabled: false,
        failedStepNo: failedStep?.stepNo,
        failure: failedStep?.failure ?? undefined,
      });
    } else if (hydrated.phase === 'done') {
      setExec({
        attemptId: currentAttemptId!,
        state,
        stateVersion: restoredStateVersion,
        status: state as 'completed' | 'completed_with_gaps',
        executionDisabled: false,
        gapCount: currentExecutionGapCount({
          plan: current.activePlan?.plan,
          executionSteps: current.executionSteps,
        }),
      });
    } else {
      setExec(null);
    }
    setPhase(hydrated.phase);

    if (hydrated.phase !== 'done') return;
    setReportState('loading');
    try {
      const [restoredFinalReport, restoredSkillResults] = await Promise.all([
        api.controlFinalReport(current.task.id),
        api.controlSkillResults(current.task.id),
      ]);
      if (generation !== restoreGeneration.current) return;
      setFinalReport(restoredFinalReport);
      setSkillResults(restoredSkillResults.results);
      setReportState('ready');
      await loadTaskFollowUps(current.task.id, generation);
    } catch (cause) {
      if (generation !== restoreGeneration.current) return;
      setDeliverableError(message(cause, '报告加载失败'));
      setReportState('report-loading-error');
    }
  }, [loadTaskFollowUps]);

  const restoreTask = useCallback(async (
    taskId: string,
    options: { loading?: boolean; silent?: boolean } = {},
  ): Promise<boolean> => {
    const generation = ++restoreGeneration.current;
    localStorage.setItem(CURRENT_TASK_STORAGE_KEY, taskId);
    setCurrentTaskId(taskId);
    if (options.loading !== false) {
      setPhase('loading-task');
      setError('');
    }
    try {
      const current = await api.controlTask(taskId);
      if (generation !== restoreGeneration.current) return false;
      await applyCurrentTask(current, generation);
      return generation === restoreGeneration.current;
    } catch (cause) {
      if (generation !== restoreGeneration.current) return false;
      setError(message(cause, '任务恢复失败'));
      if (!options.silent) setPhase('error');
      return false;
    }
  }, [applyCurrentTask]);

  useEffect(() => {
    const taskId = taskIdFromLocationSearch(window.location.search)
      ?? localStorage.getItem(CURRENT_TASK_STORAGE_KEY);
    if (taskId) void restoreTask(taskId);
  }, [restoreTask]);

  useEffect(() => {
    if (!currentTaskId || !AUTO_REFRESH_PHASES.has(phase)) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = INITIAL_POLL_DELAY_MS;
    const poll = async (): Promise<void> => {
      const refreshed = await restoreTask(currentTaskId, { loading: false, silent: true });
      if (cancelled) return;
      delay = refreshed ? INITIAL_POLL_DELAY_MS : Math.min(delay * 2, MAX_POLL_DELAY_MS);
      timer = setTimeout(() => { void poll(); }, delay);
    };
    timer = setTimeout(() => { void poll(); }, delay);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [currentTaskId, phase, restoreTask]);

  function clearIntakeSubmission(): void {
    intakeUploadCache.current.clear();
    intakeConfirmation.current = null;
  }

  async function openTask(taskId: string): Promise<void> {
    clearIntakeSubmission();
    await restoreTask(taskId);
  }

  function reset() {
    restoreGeneration.current += 1;
    clarificationSubmission.current = createClarificationSubmissionState();
    clearIntakeSubmission();
    setClarificationSubmitting(false);
    localStorage.removeItem(CURRENT_TASK_STORAGE_KEY);
    setPhase('idle');
    setClarification(null);
    setCandidatesResp(null);
    setSelectedCandidate(null);
    setPlan(null);
    setCurrentTaskId(null);
    setStateVersion(null);
    setOriginalInput('');
    setOrchestrationMode(null);
    setExec(null);
    setExecutionSteps([]);
    setExecutionPlanSteps([]);
    setFinalReport(null);
    setSkillResults([]);
    setFollowUpMessages([]);
    setFollowUpLoading(false);
    setFollowUpSubmitting(false);
    setFollowUpError('');
    setReportState('idle');
    setDeliverableError('');
    setError('');
    setProgress([]);
    setApprovalRequirements([]);
    setPlanRecovery(null);
    setRevisionSubmitting(false);
    setCancelSubmitting(false);
  }

  async function submitInput(
    text: string,
    orchestrationMode: OrchestrationModeV1 = 'single_skill',
  ) {
    restoreGeneration.current += 1;
    clarificationSubmission.current = createClarificationSubmissionState();
    clearIntakeSubmission();
    setClarificationSubmitting(false);
    localStorage.removeItem(CURRENT_TASK_STORAGE_KEY);
    setPhase('planning');
    setClarification(null);
    setCandidatesResp(null);
    setSelectedCandidate(null);
    setPlan(null);
    setCurrentTaskId(null);
    setStateVersion(null);
    setOriginalInput(text);
    setOrchestrationMode(orchestrationMode);
    setCancelSubmitting(false);
    setExec(null);
    setExecutionSteps([]);
    setExecutionPlanSteps([]);
    setFinalReport(null);
    setSkillResults([]);
    setFollowUpMessages([]);
    setFollowUpLoading(false);
    setFollowUpSubmitting(false);
    setFollowUpError('');
    setReportState('idle');
    setDeliverableError('');
    setError('');
    setProgress([]);
    setApprovalRequirements([]);
    setPlanRecovery(null);
    try {
      const response = await api.planControlStream(
        { originalInput: text, orchestrationMode },
        {
          onProgress: (event) => {
            setProgress((previous) => upsertPlanningProgress(previous, event));
          },
        },
      );
      localStorage.setItem(CURRENT_TASK_STORAGE_KEY, response.task.id);
      setCurrentTaskId(response.task.id);
      setStateVersion(response.task.stateVersion);
      if (response.status === 'clarification_required') {
        setClarification(response);
        setCandidatesResp(null);
        setPhase('clarifying');
      } else {
        setCandidatesResp(response);
        setPhase('picking');
      }
    } catch (cause) {
      setError(message(cause, '规划失败'));
      setPhase('error');
    }
  }

  async function submitClarification(input: Omit<ClarifyControlTaskRequest, 'idempotencyKey'>) {
    if (!clarification) return;
    const started = beginClarificationSubmission(
      clarificationSubmission.current,
      { taskId: clarification.task.id, ...input },
      () => ({ requestId: createRequestId(), idempotencyKey: createRequestId() }),
    );
    clarificationSubmission.current = started.state;
    if (!started.request) return;
    const { requestId, idempotencyKey } = started.request;
    setClarificationSubmitting(true);
    setPhase('clarifying');
    setError('');
    setProgress([]);
    try {
      const response = await api.clarifyControlTaskStream(
        clarification.task.id,
        { ...input, idempotencyKey },
        {
          onProgress: (event) => {
            setProgress((previous) => upsertPlanningProgress(previous, event));
          },
        },
      );
      const settled = settleClarificationSubmission(
        clarificationSubmission.current,
        requestId,
        'success',
      );
      clarificationSubmission.current = settled.state;
      if (!settled.accepted) return;
      setClarificationSubmitting(false);
      setStateVersion(response.task.stateVersion);
      if (response.status === 'clarification_required') {
        setClarification(response);
        setPhase('clarifying');
      } else {
        setClarification(null);
        setCandidatesResp(response);
        setPhase('picking');
      }
    } catch (cause) {
      const settled = settleClarificationSubmission(
        clarificationSubmission.current,
        requestId,
        'failure',
      );
      clarificationSubmission.current = settled.state;
      if (!settled.accepted) return;
      setClarificationSubmitting(false);
      setError(message(cause, '澄清提交失败'));
      setPhase('clarifying');
    }
  }

  async function pickCandidate(planVersionId: CurrentPlanCandidate['planVersionId']) {
    if (!candidatesResp || stateVersion == null) return;
    const candidate = candidatesResp.candidates.find((item) => item.planVersionId === planVersionId);
    if (!candidate) return;
    clearIntakeSubmission();
    setSelectedCandidate(candidate);
    setPhase('selecting');
    setError('');
    try {
      const selected = await api.selectControlPlan(candidatesResp.task.id, {
        expectedVersion: stateVersion,
        planVersionId,
        idempotencyKey: createRequestId(),
      });
      setStateVersion(selected.stateVersion);
      setPlan(planView(candidatesResp, candidate));
      setExecutionPlanSteps(candidate.plan.steps);
      setPlanRecovery(null);
      setPhase('planned');
    } catch (cause) {
      setError(message(cause, '候选选择失败'));
      setSelectedCandidate(null);
      setPlan(null);
      setExecutionPlanSteps([]);
      setPhase('picking');
    }
  }

  async function finishExecution(result: ControlExecutionResult) {
    const taskId = currentTaskId ?? candidatesResp?.task.id;
    if (!taskId) return;
    setExec(result);
    setStateVersion(result.stateVersion);
    if (result.state === 'paused' || result.status === 'paused') {
      setPhase('paused');
      try {
        await refreshExecutionSteps(taskId);
      } catch (cause) {
        setError(message(cause, '执行步骤加载失败'));
      }
      return;
    }

    setPhase('done');
    setReportState('loading');
    setDeliverableError('');
    try {
      await refreshExecutionSteps(taskId);
    } catch (cause) {
      setError(message(cause, '执行步骤加载失败'));
    }
    await loadDeliverable(taskId);
  }

  async function execute(version: number) {
    if (!candidatesResp || !selectedCandidate) return;
    const result = await api.executeControlPlan(candidatesResp.task.id, {
      expectedVersion: version,
      planVersionId: selectedCandidate.planVersionId,
      idempotencyKey: createRequestId(),
    });
    await finishExecution(result);
  }

  async function startExecution() {
    if (stateVersion == null) return;
    setPhase('executing');
    setError('');
    try {
      await execute(stateVersion);
    } catch (cause) {
      setError(message(cause, '执行失败'));
      setPhase('error');
    }
  }

  async function confirmPlan(
    userAnswers: Record<string, unknown>,
    pendingValues: Record<string, unknown> = {},
    visualUploads: VisualUpload[] = [],
    datasetUploads: DatasetUpload[] = [],
    documentUploads: DocumentUpload[] = [],
    waivedInputKeys: string[] = [],
  ): Promise<void> {
    if (!candidatesResp || !selectedCandidate || stateVersion == null) {
      throw new Error('当前计划状态不完整，请重新打开任务');
    }
    if (planRecovery) {
      throw new Error('当前计划需要重新生成，不能直接确认');
    }
    setError('');
    try {
      const answers = buildConfirmationAnswers(
        'confirmations' in candidatesResp.structuredTask
          ? confirmationRequirements(candidatesResp.structuredTask.confirmations)
          : [],
        userAnswers,
      );
      const inputValues: Record<string, unknown> = Object.create(null);
      for (const [role, value] of Object.entries(pendingValues)) {
        const pendingInput = selectedCandidate.pendingInputs.find((input) => input.role === role);
        if (pendingInput?.kind === 'value') inputValues[role] = value;
      }
      const taskId = candidatesResp.task.id;
      const planVersionId = selectedCandidate.planVersionId;
      const operations: Array<() => Promise<void>> = [];
      for (const upload of visualUploads) {
        const pendingInput = selectedCandidate.pendingInputs.find((input) => input.role === upload.role);
        if (pendingInput?.kind !== 'visual') continue;
        operations.push(async () => {
          const cacheKey = `${planVersionId}:visual:${upload.role}`;
          const cached = intakeUploadCache.current.get(cacheKey);
          if (cached && cached.metadata === null && sameFiles(cached.files, upload.files)) {
            inputValues[upload.role] = cached.inputId;
            return;
          }
          const uploaded = await api.uploadControlVisuals(
            taskId,
            planVersionId,
            upload.role,
            upload.files,
            createRequestId(),
          );
          intakeUploadCache.current.set(cacheKey, {
            files: [...upload.files], metadata: null, inputId: uploaded.visualInputId,
          });
          inputValues[upload.role] = uploaded.visualInputId;
        });
      }
      for (const upload of datasetUploads) {
        const pendingInput = selectedCandidate.pendingInputs.find((input) => input.role === upload.role);
        if (pendingInput?.kind !== 'dataset') continue;
        operations.push(async () => {
          const cacheKey = `${planVersionId}:dataset:${upload.role}`;
          const metadata = JSON.stringify(upload.metadata);
          const cached = intakeUploadCache.current.get(cacheKey);
          if (cached && cached.metadata === metadata && sameFiles(cached.files, [upload.file])) {
            inputValues[upload.role] = cached.inputId;
            return;
          }
          const uploaded = await api.uploadControlDataset(
            taskId,
            planVersionId,
            upload.role,
            upload.file,
            upload.metadata,
            createRequestId(),
          );
          intakeUploadCache.current.set(cacheKey, {
            files: [upload.file], metadata, inputId: uploaded.datasetInputId,
          });
          inputValues[upload.role] = uploaded.datasetInputId;
        });
      }
      for (const upload of documentUploads) {
        const pendingInput = selectedCandidate.pendingInputs.find((input) => input.role === upload.role);
        if (pendingInput?.kind !== 'document') continue;
        operations.push(async () => {
          const cacheKey = `${planVersionId}:document:${upload.role}`;
          const cached = intakeUploadCache.current.get(cacheKey);
          if (cached && cached.metadata === null && sameFiles(cached.files, upload.files)) {
            inputValues[upload.role] = cached.inputId;
            return;
          }
          const uploaded = await api.uploadControlDocuments(
            taskId,
            planVersionId,
            upload.role,
            upload.files,
            createRequestId(),
          );
          intakeUploadCache.current.set(cacheKey, {
            files: [...upload.files], metadata: null, inputId: uploaded.documentInputId,
          });
          inputValues[upload.role] = uploaded.documentInputId;
        });
      }
      await runIntakeUploads(operations);
      const confirmationSignature = JSON.stringify({
        confirmationAnswers: sortedRecord(answers),
        inputValues: sortedRecord(inputValues),
        waivedInputKeys: [...waivedInputKeys].sort(),
      });
      const cachedConfirmation = intakeConfirmation.current;
      const confirmationIdempotencyKey = cachedConfirmation?.planVersionId === planVersionId
        && cachedConfirmation.signature === confirmationSignature
        ? cachedConfirmation.idempotencyKey
        : createRequestId();
      intakeConfirmation.current = {
        planVersionId,
        signature: confirmationSignature,
        idempotencyKey: confirmationIdempotencyKey,
      };
      const confirmed = await api.confirmControlPlan(taskId, {
        expectedVersion: stateVersion,
        planVersionId,
        confirmationAnswers: answers,
        inputValues,
        waivedInputKeys,
        idempotencyKey: confirmationIdempotencyKey,
      });
      clearIntakeSubmission();
      setStateVersion(confirmed.stateVersion);
      if (confirmed.state === 'ready') {
        setPhase('ready');
      } else if (confirmed.state === 'awaiting_approval') {
        setPhase('awaiting-approval');
      } else {
        throw new Error(`确认后任务进入未预期状态：${confirmed.state}`);
      }
    } catch (cause) {
      const failureMessage = message(cause, '信息上传或确认失败');
      setError(failureMessage);
      setPhase('planned');
      throw cause instanceof Error ? cause : new Error(failureMessage);
    }
  }

  async function revisePlan(revisionInstruction = '按当前输入契约重新生成计划，保持原研究目标和当前候选方向不变。'): Promise<void> {
    if (!currentTaskId || !selectedCandidate || stateVersion == null || revisionSubmitting) return;
    clearIntakeSubmission();
    setRevisionSubmitting(true);
    setError('');
    try {
      await api.reviseControlPlan(currentTaskId, {
        expectedVersion: stateVersion,
        revisionInstruction,
        idempotencyKey: createRequestId(),
      });
      await restoreTask(currentTaskId);
    } catch (cause) {
      setError(message(cause, '计划重新生成失败'));
      setPhase('error');
    } finally {
      setRevisionSubmitting(false);
    }
  }

  async function approveTask(gateKey: string): Promise<void> {
    if (!currentTaskId || !selectedCandidate || stateVersion == null) return;
    const requirement = approvalRequirements.find((item) => item.gateKey === gateKey);
    if (!approvalSubmissionAllowed(requirement)) return;

    setApprovalSubmitting(true);
    setError('');
    try {
      await api.approveControlPlan(currentTaskId, {
        expectedVersion: stateVersion,
        planVersionId: selectedCandidate.planVersionId,
        gateKey,
        decision: 'approved',
        idempotencyKey: createRequestId(),
      });
      await restoreTask(currentTaskId, { loading: false });
    } catch (cause) {
      setError(message(cause, '审批提交失败'));
    } finally {
      setApprovalSubmitting(false);
    }
  }

  async function cancelExecution(): Promise<void> {
    if (!candidatesResp || stateVersion == null || cancelSubmitting) return;
    setCancelSubmitting(true);
    setError('');
    try {
      const cancelled = await api.cancelControlPlan(candidatesResp.task.id, {
        expectedVersion: stateVersion,
        idempotencyKey: createRequestId(),
      });
      setStateVersion(cancelled.stateVersion);
      setPhase('cancelled');
      await refreshExecutionSteps(candidatesResp.task.id);
    } catch (cause) {
      setError(message(cause, '取消执行失败'));
    } finally {
      setCancelSubmitting(false);
    }
  }

  async function resumeStep(action: 'retry' | 'abort') {
    if (!candidatesResp || stateVersion == null) return;
    setPhase('executing');
    setError('');
    try {
      const resumed = await api.resumeControlPlan(candidatesResp.task.id, {
        expectedVersion: stateVersion,
        action,
        failedStepNo: exec?.failedStepNo,
        idempotencyKey: createRequestId(),
      });
      setStateVersion(resumed.stateVersion);
      try {
        await refreshExecutionSteps(candidatesResp.task.id);
      } catch (cause) {
        setError(message(cause, '执行步骤加载失败'));
      }
      if (resumed.state === 'cancelled') {
        setPhase('cancelled');
      } else if (resumed.state === 'ready') {
        await execute(resumed.stateVersion);
      } else if (resumed.state === 'paused') {
        setPhase('paused');
      } else {
        setError(`恢复后任务进入未预期状态：${resumed.state}`);
        setPhase('error');
      }
    } catch (cause) {
      setError(message(cause, '恢复失败'));
      setPhase('error');
    }
  }

  async function submitFollowUp(content: string): Promise<boolean> {
    if (!currentTaskId || !finalReport || phase !== 'done' || followUpSubmitting) return false;
    const taskId = currentTaskId;
    const generation = restoreGeneration.current;
    setFollowUpSubmitting(true);
    setFollowUpError('');
    try {
      const response = await api.createControlFollowUp(
        taskId,
        { message: content },
        createRequestId(),
      );
      if (generation !== restoreGeneration.current) return false;
      setFollowUpMessages((previous) => {
        const byId = new Map(previous.map((item) => [item.id, item]));
        for (const item of response.messages) byId.set(item.id, item);
        return [...byId.values()].sort((left, right) => (
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
        ));
      });
      return true;
    } catch (cause) {
      if (generation !== restoreGeneration.current) return false;
      setFollowUpError(message(cause, '报告追问失败'));
      return false;
    } finally {
      if (generation === restoreGeneration.current) {
        setFollowUpSubmitting(false);
      }
    }
  }

  function retryDeliverable() {
    if (currentTaskId) void loadDeliverable(currentTaskId);
  }

  return {
    phase,
    clarification,
    submitClarification,
    clarificationSubmitting,
    candidatesResp,
    selectedCandidate,
    selectedCandidateId: selectedCandidate?.planVersionId ?? null,
    plan,
    stateVersion,
    planVersionId: selectedCandidate?.planVersionId ?? null,
    originalInput,
    orchestrationMode,
    exec,
    executionSteps,
    executionPlanSteps,
    finalReport,
    skillResults,
    reportState,
    deliverableError,
    followUpMessages,
    followUpLoading,
    followUpSubmitting,
    followUpError,
    error,
    progress,
    currentTaskId,
    approvalRequirements,
    approvalSubmitting,
    planRecovery,
    revisionSubmitting,
    cancelSubmitting,
    reset,
    openTask,
    submitInput,
    pickCandidate,
    confirmPlan,
    revisePlan,
    approveTask,
    startExecution,
    cancelExecution,
    resumeStep,
    submitFollowUp,
    retryDeliverable,
  };
}
