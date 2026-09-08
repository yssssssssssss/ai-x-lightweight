import {
  isCandidateProfile,
  isExplicitClarificationAnswer,
  missingRequiredClarificationAnswers,
  type ResearchTaskV2Ambiguity,
  type ResearchTaskV2ClarificationQuestion,
} from '../../../packages/api-contract/plan.ts';
import type {
  ControlApprovalRequirement,
  ControlExecutionStepResponse,
  ControlPlanCandidatesResponse,
  ControlWorkflowState,
  CurrentPlanCandidate,
  PlanningGuidanceClarification,
} from '../../../packages/api-contract/control-workflow.ts';
export {
  executionFailureAllowsAction,
  selectAuthoritativeFailedStep,
} from '../../../packages/api-contract/control-workflow.ts';

import type {
  ExecLogRow,
  TaskHistoryKind,
  TaskHistoryPreference,
  TaskSummary,
} from '../../../packages/api-contract/http.ts';

export interface ConfirmationRequirement {
  key: string;
  question?: string;
  suggestion?: unknown;
}

export type ReportState = 'idle' | 'loading' | 'ready' | 'report-loading-error';
export interface CurrentHistoryTaskSummary {
  id: string;
  originalInput: string;
  taskType: string | null;
  state: string;
  createdAt: string;
  updatedAt: string;
  requiresAction?: boolean;
}

export interface HistoryTaskSummary extends TaskSummary {
  kind: TaskHistoryKind;
  displayName?: string | null;
  pinnedAt?: string | null;
  requiresAction?: boolean;
}

export type TaskHistoryGroup = 'pending' | 'running' | 'completed' | 'failed';
export type TaskStateTone = 'action' | 'running' | 'success' | 'warning' | 'danger' | 'muted';

export interface TaskStatePresentation {
  label: string;
  group: TaskHistoryGroup;
  tone: TaskStateTone;
}

export function approvalSubmissionAllowed(
  requirement: Pick<ControlApprovalRequirement, 'decision' | 'canApprove'> | undefined,
): boolean {
  return requirement?.decision === 'pending' && requirement.canApprove;
}

const TASK_STATE_PRESENTATIONS: Record<ControlWorkflowState, TaskStatePresentation> = {
  awaiting_clarification: { label: '待补充', group: 'pending', tone: 'action' },
  awaiting_selection: { label: '待选方案', group: 'pending', tone: 'action' },
  awaiting_confirmation: { label: '待确认', group: 'pending', tone: 'action' },
  awaiting_approval: { label: '审批中', group: 'running', tone: 'running' },
  ready: { label: '待执行', group: 'pending', tone: 'action' },
  executing: { label: '执行中', group: 'running', tone: 'running' },
  paused: { label: '已暂停', group: 'pending', tone: 'warning' },
  reviewing: { label: '质量复核中', group: 'running', tone: 'running' },
  composing_report: { label: '报告生成中', group: 'running', tone: 'running' },
  completed: { label: '已完成', group: 'completed', tone: 'success' },
  completed_with_gaps: { label: '已完成·有缺口', group: 'completed', tone: 'warning' },
  failed: { label: '失败', group: 'failed', tone: 'danger' },
  cancelled: { label: '已取消', group: 'failed', tone: 'muted' },
  rejected: { label: '已驳回', group: 'failed', tone: 'danger' },
};

function isControlWorkflowState(state: string): state is ControlWorkflowState {
  return Object.prototype.hasOwnProperty.call(TASK_STATE_PRESENTATIONS, state);
}

export function taskStatePresentation(state: string): TaskStatePresentation {
  if (!isControlWorkflowState(state)) throw new Error(`unsupported Current task state: ${state}`);
  return TASK_STATE_PRESENTATIONS[state];
}

export function historyTaskPresentation(task: HistoryTaskSummary): TaskStatePresentation {
  if (task.kind === 'current') {
    if (task.status === 'awaiting_approval' && task.requiresAction) {
      return { label: '待审批', group: 'pending', tone: 'action' };
    }
    if (task.status === 'completed' || task.status === 'completed_with_gaps') {
      if (task.task_type === 'research_synthesis') {
        return {
          label: task.status === 'completed_with_gaps' ? '研究答案已完成·有缺口' : '研究答案已完成',
          group: 'completed',
          tone: task.status === 'completed_with_gaps' ? 'warning' : 'success',
        };
      }
      if (task.task_type === 'user_research_planning') {
        return {
          label: task.status === 'completed_with_gaps' ? '研究方案已生成·有缺口' : '研究方案已生成',
          group: 'completed',
          tone: task.status === 'completed_with_gaps' ? 'warning' : 'success',
        };
      }
    }
    try {
      return taskStatePresentation(task.status);
    } catch {
      return { label: '状态异常', group: 'failed', tone: 'danger' };
    }
  }
  if (['completed', 'completed_with_gaps', 'succeeded', 'done'].includes(task.status)) {
    return {
      label: task.status === 'completed_with_gaps' ? '历史·已完成·有缺口' : '历史·已完成',
      group: 'completed',
      tone: task.status === 'completed_with_gaps' ? 'warning' : 'success',
    };
  }
  if (['failed', 'cancelled', 'rejected'].includes(task.status)) {
    return {
      label: task.status === 'cancelled' ? '历史·已取消' : task.status === 'rejected' ? '历史·已驳回' : '历史·失败',
      group: 'failed',
      tone: task.status === 'cancelled' ? 'muted' : 'danger',
    };
  }
  if (['running', 'executing', 'reviewing', 'composing_report'].includes(task.status)) {
    return { label: `历史·${task.status}`, group: 'running', tone: 'running' };
  }
  return { label: `历史·${task.status}`, group: 'pending', tone: 'muted' };
}

function timestamp(value: string | undefined): number {
  const parsed = Date.parse(value ?? '');
  return Number.isNaN(parsed) ? 0 : parsed;
}

const LOCAL_TIME_FORMAT = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function formatLocalDateTime(value: string | undefined): string {
  const milliseconds = timestamp(value);
  return milliseconds === 0 ? '时间未知' : LOCAL_TIME_FORMAT.format(new Date(milliseconds));
}

export function formatElapsedTime(start: string | undefined, end: string | undefined): string {
  const startedAt = timestamp(start);
  const endedAt = timestamp(end);
  if (startedAt === 0 || endedAt < startedAt) return '用时未知';
  const elapsed = endedAt - startedAt;
  if (elapsed < 60_000) return '不足 1 分钟';
  const totalMinutes = Math.floor(elapsed / 60_000);
  if (totalMinutes < 60) return `${totalMinutes} 分钟`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) return minutes === 0 ? `${hours} 小时` : `${hours} 小时 ${minutes} 分钟`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours === 0 ? `${days} 天` : `${days} 天 ${remainingHours} 小时`;
}

export function applyTaskHistoryPreferences(
  tasks: HistoryTaskSummary[],
  preferences: TaskHistoryPreference[],
): HistoryTaskSummary[] {
  const preferencesByTask = new Map(
    preferences.map((preference) => [`${preference.taskKind}:${preference.taskId}`, preference]),
  );
  return tasks.flatMap((task): HistoryTaskSummary[] => {
    const preference = preferencesByTask.get(`${task.kind}:${task.id}`);
    if (preference?.hiddenAt) return [];
    if (!preference) return [task];
    return [{
      ...task,
      displayName: preference.displayName,
      pinnedAt: preference.pinnedAt,
    }];
  }).sort((left, right) => {
    if (left.pinnedAt && !right.pinnedAt) return -1;
    if (!left.pinnedAt && right.pinnedAt) return 1;
    if (left.pinnedAt && right.pinnedAt) {
      const pinnedOrder = timestamp(right.pinnedAt) - timestamp(left.pinnedAt);
      if (pinnedOrder !== 0) return pinnedOrder;
    }
    return timestamp(right.updated_at ?? right.created_at) - timestamp(left.updated_at ?? left.created_at);
  });
}

export function mergeTaskHistory(
  legacyTasks: TaskSummary[],
  currentTasks: CurrentHistoryTaskSummary[],
  preferences: TaskHistoryPreference[] = [],
): HistoryTaskSummary[] {
  const history: HistoryTaskSummary[] = [
    ...legacyTasks.map((task) => ({ ...task, kind: 'legacy' as const })),
    ...currentTasks.map((task) => ({
      kind: 'current' as const,
      id: task.id,
      original_input: task.originalInput,
      task_type: task.taskType,
      status: task.state,
      created_at: task.createdAt,
      ...(task.updatedAt ? { updated_at: task.updatedAt } : {}),
      ...(task.requiresAction ? { requiresAction: true } : {}),
    })),
  ];
  return applyTaskHistoryPreferences(history, preferences);
}
export interface RequestIdCrypto {
  randomUUID?: () => string;
  getRandomValues(values: Uint8Array): Uint8Array;
}

export function createRequestId(source: RequestIdCrypto = globalThis.crypto): string {
  if (typeof source.randomUUID === 'function') return source.randomUUID();
  const bytes = source.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}



export interface CompletedExecution {
  attemptId: string;
  state: 'completed' | 'completed_with_gaps';
  status: 'completed' | 'completed_with_gaps';
  stateVersion: number;
  executionDisabled?: false;
  deliverableArtifactId?: string;
  evidenceManifestArtifactId?: string;
  gapCount?: number;
}

export interface DeliverableReadState<TDeliverable = unknown> {
  phase: 'executing' | 'done' | 'error';
  reportState: ReportState;
  execution: CompletedExecution | null;
  deliverable: TDeliverable | null;
  executionError: string | null;
  reportError: string | null;
}

export interface FlowTransition<TDeliverable = unknown> {
  state: DeliverableReadState<TDeliverable>;
  effect: 'load-deliverable' | null;
}


export function buildConfirmationAnswers(
  requirements: ConfirmationRequirement[],
  userAnswers: Record<string, unknown>,
): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  const missing: string[] = [];

  for (const requirement of requirements) {
    const value = userAnswers[requirement.key];
    const answered = Object.prototype.hasOwnProperty.call(userAnswers, requirement.key)
      && value !== undefined
      && value !== null
      && (typeof value !== 'string' || value.trim() !== '');
    if (!answered) {
      missing.push(requirement.key);
      continue;
    }
    answers[requirement.key] = value;
  }

  if (missing.length > 0) {
    throw new Error(`Unresolved confirmation answers: ${missing.join(', ')}`);
  }
  return answers;
}

export interface ExecutionPlanStepView {
  step_no: number;
  step_name: string;
  actor_type: string;
  actor_id: string;
  depends_on?: readonly number[];
  skill_invocation_id?: string;
  shared_stage_key?: string;
  shared_by_invocation_ids?: readonly string[];
}

export function executionPlanStepsForTask(input: {
  activePlan?: {
    plan: {
      steps: readonly ExecutionPlanStepView[];
    };
  } | null;
  executionSteps: readonly ControlExecutionStepResponse[];
}): ExecutionPlanStepView[] {
  const activeSteps = input.activePlan?.plan.steps;
  if (activeSteps && activeSteps.length > 0) {
    return activeSteps.map((step) => ({
      step_no: step.step_no,
      step_name: step.step_name,
      actor_type: step.actor_type,
      actor_id: step.actor_id,
      ...(Array.isArray(step.depends_on) ? { depends_on: [...step.depends_on] } : {}),
      ...(typeof step.skill_invocation_id === 'string' ? { skill_invocation_id: step.skill_invocation_id } : {}),
      ...(typeof step.shared_stage_key === 'string' ? { shared_stage_key: step.shared_stage_key } : {}),
      ...(Array.isArray(step.shared_by_invocation_ids)
        ? { shared_by_invocation_ids: [...step.shared_by_invocation_ids] }
        : {}),
    }));
  }
  return input.executionSteps.map((step) => ({
    step_no: step.stepNo,
    step_name: step.stepName,
    actor_type: step.actorType,
    actor_id: step.actorId,
  }));
}

export function executionStepsToExecLog(steps: ControlExecutionStepResponse[]): ExecLogRow[] {
  return steps.map((step) => ({
    step_no: step.stepNo,
    step_name: step.stepName,
    actor_type: step.actorType,
    actor_id: step.actorId,
    status: step.state,
    ...(step.outputArtifactId ? { outputArtifactId: step.outputArtifactId } : {}),
    skillProvenance: step.skillProvenance,
    ...(step.failure ? { failure: step.failure } : {}),
  }));
}

function gapSummaryKeys(value: unknown): string[] | null {
  if (!isRecord(value)) return null;
  const fields = Object.keys(value).sort();
  if (JSON.stringify(fields) !== JSON.stringify(['count', 'failuresHash', 'keys'])) return null;
  const { count, keys, failuresHash } = value;
  if (
    typeof count !== 'number'
    || !Number.isInteger(count)
    || count <= 0
    || !Array.isArray(keys)
    || keys.length !== count
    || !keys.every((key): key is string => typeof key === 'string')
    || new Set(keys).size !== keys.length
    || typeof failuresHash !== 'string'
    || !/^sha256:[a-f0-9]{64}$/u.test(failuresHash)
  ) return null;
  const pageKeys = keys.every((key) => /^(?:0|[1-9]\d*):[a-z][a-z0-9_]*$/u.test(key));
  const stepKeys = keys.length === 1 && /^step:[a-z][a-z0-9_]*$/u.test(keys[0]!);
  if (!pageKeys && !stepKeys) return null;
  return keys;
}

export function currentExecutionGapCount(input: {
  plan: unknown;
  executionSteps: readonly ControlExecutionStepResponse[];
}): number {
  const keys = new Set<string>();
  if (isRecord(input.plan) && Array.isArray(input.plan.capability_gaps)) {
    for (const gap of input.plan.capability_gaps) {
      if (
        !isRecord(gap)
        || gap.capability_type !== 'tool'
        || typeof gap.capability_id !== 'string'
        || typeof gap.code !== 'string'
      ) continue;
      keys.add(`capability:${gap.capability_id}:${gap.code}`);
    }
  }
  if (isRecord(input.plan) && Array.isArray(input.plan.skill_invocations)) {
    for (const invocation of input.plan.skill_invocations) {
      if (!isRecord(invocation) || typeof invocation.invocation_id !== 'string' || !Array.isArray(invocation.resource_gaps)) continue;
      for (const gap of invocation.resource_gaps) {
        if (!isRecord(gap) || typeof gap.query_id !== 'string' || gap.failure_policy !== 'gap') continue;
        keys.add(`skill:${invocation.invocation_id}:resource:${gap.query_id}`);
      }
    }
  }
  for (const step of input.executionSteps) {
    const skillProvenance = step.skillProvenance;
    if (isRecord(skillProvenance) && skillProvenance.status === 'degraded') {
      keys.add(`step:${step.stepNo}:skill:${step.actorId}:degraded`);
    }
    const provenance = step.toolProvenance;
    if (isRecord(provenance) && Object.prototype.hasOwnProperty.call(provenance, 'gapSummary')) {
      const summaryKeys = gapSummaryKeys(provenance.gapSummary);
      if (summaryKeys) {
        for (const key of summaryKeys) keys.add(`step:${step.stepNo}:${key}`);
      }
      continue;
    }
    if (step.state === 'skipped') keys.add(`legacy-skipped:${step.stepNo}`);
  }
  return keys.size;
}

export function finishExecution<TDeliverable>(
  state: DeliverableReadState<TDeliverable>,
  execution: CompletedExecution,
): FlowTransition<TDeliverable> {
  return {
    state: {
      ...state,
      phase: 'done',
      reportState: 'loading',
      execution,
      executionError: null,
      reportError: null,
    },
    effect: 'load-deliverable',
  };
}

export function failDeliverableRead<TDeliverable>(
  state: DeliverableReadState<TDeliverable>,
  error: string,
): FlowTransition<TDeliverable> {
  return {
    state: {
      ...state,
      phase: 'done',
      reportState: 'report-loading-error',
      reportError: error,
    },
    effect: null,
  };
}

export function retryDeliverable<TDeliverable>(
  state: DeliverableReadState<TDeliverable>,
): FlowTransition<TDeliverable> {
  return {
    state: {
      ...state,
      phase: 'done',
      reportState: 'loading',
      reportError: null,
    },
    effect: 'load-deliverable',
  };
}

export type ClarificationQuestionState = ResearchTaskV2ClarificationQuestion;

export interface ClarificationRequirementState {
  clarification_questions: ClarificationQuestionState[];
  ambiguities: ResearchTaskV2Ambiguity[];
  assumptions: Array<{ key: string; value: string; editable: boolean }>;
}

export function missingBlockingAnswers(
  requirement: ClarificationRequirementState,
  answers: Record<string, unknown>,
): string[] {
  return missingRequiredClarificationAnswers(requirement, answers);
}

export function buildClarificationSubmission(
  requirement: ClarificationRequirementState,
  answers: Record<string, unknown>,
  assumptionEdits: Record<string, string>,
): { clarificationAnswers: Record<string, unknown>; assumptionEdits: Record<string, string> } {
  const questionKeys = new Set(requirement.clarification_questions.map((question) => question.key));
  const editableKeys = new Set(
    requirement.assumptions.filter((assumption) => assumption.editable).map((assumption) => assumption.key),
  );
  return {
    clarificationAnswers: Object.fromEntries(
      Object.entries(answers).filter(([key, value]) => (
        questionKeys.has(key) && isExplicitClarificationAnswer(value)
      )),
    ),
    assumptionEdits: Object.fromEntries(
      Object.entries(assumptionEdits).filter(([key, value]) => editableKeys.has(key) && value.trim().length > 0),
    ),
  };
}

export interface ClarificationSubmissionState {
  pending: { fingerprint: string; idempotencyKey: string } | null;
  activeRequestId: string | null;
}

export interface ClarificationSubmissionRequest {
  requestId: string;
  idempotencyKey: string;
}

function stableClarificationValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableClarificationValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableClarificationValue(child)]),
  );
}

export function createClarificationSubmissionState(): ClarificationSubmissionState {
  return { pending: null, activeRequestId: null };
}

export function beginClarificationSubmission(
  state: ClarificationSubmissionState,
  payload: unknown,
  createIdentity: () => ClarificationSubmissionRequest,
): { state: ClarificationSubmissionState; request: ClarificationSubmissionRequest | null } {
  const fingerprint = JSON.stringify(stableClarificationValue(payload));
  if (state.activeRequestId && state.pending?.fingerprint === fingerprint) {
    return { state, request: null };
  }
  const identity = createIdentity();
  const pending = state.pending?.fingerprint === fingerprint
    ? state.pending
    : { fingerprint, idempotencyKey: identity.idempotencyKey };
  return {
    state: { pending, activeRequestId: identity.requestId },
    request: { requestId: identity.requestId, idempotencyKey: pending.idempotencyKey },
  };
}

export function settleClarificationSubmission(
  state: ClarificationSubmissionState,
  requestId: string,
  outcome: 'success' | 'failure',
): { state: ClarificationSubmissionState; accepted: boolean } {
  if (state.activeRequestId !== requestId) return { state, accepted: false };
  return {
    state: {
      pending: outcome === 'success' ? null : state.pending,
      activeRequestId: null,
    },
    accepted: true,
  };
}
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isRestorableClarificationRequirement(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.version === 'research-task-v2'
    && isNonEmptyString(value.task_type)
    && isNonEmptyString(value.business_domain)
    && isNonEmptyString(value.research_goal)
    && Array.isArray(value.assumptions)
    && value.assumptions.every((assumption) => isRecord(assumption)
      && isNonEmptyString(assumption.key)
      && typeof assumption.value === 'string'
      && typeof assumption.editable === 'boolean')
    && Array.isArray(value.ambiguities)
    && value.ambiguities.every((ambiguity) => isRecord(ambiguity)
      && isNonEmptyString(ambiguity.id)
      && isNonEmptyString(ambiguity.statement)
      && typeof ambiguity.blocking === 'boolean')
    && Array.isArray(value.clarification_questions)
    && value.clarification_questions.every((question) => isRecord(question)
      && isNonEmptyString(question.key)
      && isNonEmptyString(question.question)
      && isNonEmptyString(question.rationale));
}

function isRestorableCandidate(value: unknown): value is CurrentPlanCandidate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<CurrentPlanCandidate>;
  return isCandidateProfile(candidate.candidateId)
    && isNonEmptyString(candidate.planVersionId)
    && isNonEmptyString(candidate.title)
    && isNonEmptyString(candidate.rationale)
    && isNonEmptyString(candidate.tradeoffs)
    && isNonEmptyString(candidate.planHash)
    && Boolean(candidate.plan && typeof candidate.plan === 'object')
    && Array.isArray(candidate.pendingInputs);
}

function isRecommendedCandidate(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const plan = isRecord(value.plan) ? value.plan : null;
  const metadata = plan && isRecord(plan.candidate_metadata) ? plan.candidate_metadata : null;
  return metadata?.recommended === true;
}

export function candidateInitialIndex(
  candidates: readonly CurrentPlanCandidate[],
  selectedPlanVersionId?: string,
): number {
  const selectedIndex = selectedPlanVersionId
    ? candidates.findIndex((candidate) => candidate.planVersionId === selectedPlanVersionId)
    : -1;
  if (selectedIndex >= 0) return selectedIndex;
  const recommendedIndex = candidates.findIndex(isRecommendedCandidate);
  return Math.max(0, recommendedIndex);
}

export interface CurrentTaskHydrationInput {
  task: {
    id: string;
    state: string;
    stateVersion: number;
    originalInput: string;
    conversationId: string;
    structuredTask: unknown;
    activePlanVersionId?: string | null;
    currentAttemptId?: string | null;
  };
  candidates?: CurrentPlanCandidate[];
  activatedNodes?: string[];
  activePlan?: CurrentPlanCandidate | null;
  planningGuidance?: PlanningGuidanceClarification;
}

export type RestoredCurrentTaskPhase =
  | 'clarifying'
  | 'picking'
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
  | 'rejected';

export function hydrateCurrentTask(input: CurrentTaskHydrationInput): {
  phase: RestoredCurrentTaskPhase;
  stateVersion: number;
  originalInput: string;
  clarification: unknown | null;
  candidatesResp: ControlPlanCandidatesResponse | null;
  selectedCandidate: CurrentPlanCandidate | null;
} {
  const { task } = input;
  if (!isControlWorkflowState(task.state)) {
    throw new Error(`unsupported Current task state: ${task.state}`);
  }
  if (task.state === 'awaiting_selection') {
    const candidates = input.candidates;
    const activatedNodes = input.activatedNodes;
    const candidateIds = candidates?.map((candidate) => candidate.candidateId) ?? [];
    const recommendedCount = candidates?.filter(isRecommendedCandidate).length ?? 0;
    if (
      !Array.isArray(candidates)
      || candidates.length < 2
      || candidates.length > 4
      || !candidates.every(isRestorableCandidate)
      || new Set(candidateIds).size !== candidateIds.length
      || !candidateIds.includes('speed')
      || !candidateIds.includes('depth')
      || recommendedCount > 1
      || !Array.isArray(activatedNodes)
      || activatedNodes.some((node) => typeof node !== 'string')
    ) {
      throw new Error('awaiting_selection task has no valid server candidate recovery payload');
    }
    return {
      phase: 'picking',
      stateVersion: task.stateVersion,
      originalInput: task.originalInput,
      clarification: null,
      selectedCandidate: null,
      candidatesResp: {
        kind: 'current',
        conversationId: task.conversationId,
        task: {
          id: task.id,
          state: 'awaiting_selection',
          stateVersion: task.stateVersion,
          activePlanVersionId: task.activePlanVersionId ?? null,
          currentAttemptId: task.currentAttemptId ?? null,
        },
        structuredTask: task.structuredTask as ControlPlanCandidatesResponse['structuredTask'],
        activatedNodes,
        candidates,
      },
    };
  }
  if (task.state === 'awaiting_clarification') {
    if (!isRestorableClarificationRequirement(task.structuredTask)) {
      throw new Error('awaiting_clarification task has no valid requirement recovery payload');
    }
    return {
      phase: 'clarifying',
      stateVersion: task.stateVersion,
      originalInput: task.originalInput,
      clarification: {
        kind: 'current',
        status: 'clarification_required',
        conversationId: task.conversationId,
        task: {
          id: task.id,
          state: task.state,
          stateVersion: task.stateVersion,
          activePlanVersionId: task.activePlanVersionId ?? null,
          currentAttemptId: task.currentAttemptId ?? null,
        },
        structuredTask: task.structuredTask,
        activatedNodes: [],
        candidates: [],
        ...(input.planningGuidance ? { planningGuidance: input.planningGuidance } : {}),
      },
      candidatesResp: null,
      selectedCandidate: null,
    };
  }

  const activePlanPhases: Partial<Record<ControlWorkflowState, RestoredCurrentTaskPhase>> = {
    awaiting_confirmation: 'planned',
    awaiting_approval: 'awaiting-approval',
    ready: 'ready',
    executing: 'executing',
    paused: 'paused',
    reviewing: 'reviewing',
    composing_report: 'composing-report',
  };
  const activePhase = activePlanPhases[task.state];
  if (activePhase) {
    const activePlan = input.activePlan;
    const plan = activePlan && isRecord(activePlan.plan) ? activePlan.plan : null;
    if (
      !activePlan
      || !isRestorableCandidate(activePlan)
      || activePlan.planVersionId !== task.activePlanVersionId
      || plan?.task_id !== task.id
      || !Array.isArray(plan.activated_nodes)
      || plan.activated_nodes.some((node) => typeof node !== 'string')
    ) {
      throw new Error(`${task.state} task has no valid active plan recovery payload`);
    }
    if (
      (task.state === 'executing'
        || task.state === 'paused'
        || task.state === 'reviewing'
        || task.state === 'composing_report')
      && !isNonEmptyString(task.currentAttemptId)
    ) {
      throw new Error(`${task.state} task has no current execution attempt`);
    }
    return {
      phase: activePhase,
      stateVersion: task.stateVersion,
      originalInput: task.originalInput,
      clarification: null,
      selectedCandidate: activePlan,
      candidatesResp: {
        kind: 'current',
        conversationId: task.conversationId,
        task: {
          id: task.id,
          state: task.state,
          stateVersion: task.stateVersion,
          activePlanVersionId: task.activePlanVersionId ?? null,
          currentAttemptId: task.currentAttemptId ?? null,
        },
        structuredTask: task.structuredTask as ControlPlanCandidatesResponse['structuredTask'],
        activatedNodes: plan.activated_nodes as string[],
        candidates: [activePlan],
      },
    };
  }

  if (
    (task.state === 'completed' || task.state === 'completed_with_gaps')
    && !isNonEmptyString(task.currentAttemptId)
  ) {
    throw new Error(`${task.state} task has no current execution attempt`);
  }
  const terminalPhases: Partial<Record<ControlWorkflowState, RestoredCurrentTaskPhase>> = {
    completed: 'done',
    completed_with_gaps: 'done',
    failed: 'failed',
    cancelled: 'cancelled',
    rejected: 'rejected',
  };
  const terminalPhase = terminalPhases[task.state];
  if (!terminalPhase) throw new Error(`unsupported Current task state: ${task.state}`);
  return {
    phase: terminalPhase,
    stateVersion: task.stateVersion,
    originalInput: task.originalInput,
    clarification: null,
    candidatesResp: null,
    selectedCandidate: null,
  };
}
