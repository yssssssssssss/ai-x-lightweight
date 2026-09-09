import Busboy from 'busboy';
import { createHash } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import {
  isExplicitClarificationAnswer,
  missingRequiredClarificationAnswers,
  type PlanProgress,
  type ResearchTaskV2,
} from '../../../../packages/api-contract/plan.ts';
import {
  type NativeSkillResult,
} from '../../../../packages/api-contract/native-skill-orchestration.ts';
import type { ControlFinalReport } from '../../../../packages/api-contract/historical-final-report.ts';
import type {
  TaskFollowUpResponse,
} from '../../../../packages/api-contract/control-workflow.ts';
import type { VisualAssetManifest } from '../../../../packages/api-contract/research-deliverable.ts';
import { ControlPlaneConflictError, type ControlPlaneRepository } from '../../../../database/control-plane.ts';
import { getUserById } from '../../../../database/repository.ts';
import {
  CandidateProfileNoLongerEligibleError,
  TaskWorkflowAuthorizationError,
  TaskWorkflowGateError,
  requiredApprovals,
  type TaskWorkflowService,
  type WorkflowActor,
} from '../../../orchestrator-runtime/src/control/task-workflow.ts';
import { assertVisualAssetManifestSchema } from '../../../orchestrator-runtime/src/report/visual-asset-service.ts';
import {
  TaskFollowUpError,
  type TaskFollowUpService,
} from '../../../orchestrator-runtime/src/report/task-follow-up-service.ts';
import { EditorialSummaryPipelineError } from '../../../orchestrator-runtime/src/report/editorial-summary-pipeline.ts';
import { EditorialSummaryStoreError } from '../../../orchestrator-runtime/src/report/editorial-summary-store.ts';
import {
  HtmlBundleIntegrityError,
  HtmlBundleUnavailableError,
} from '../../../orchestrator-runtime/src/report/standalone-html-report-package.ts';
import { LLMInvocationError } from '../../../orchestrator-runtime/src/runtime/llm-client.ts';
import { SchemaValidator } from '../../../orchestrator-runtime/src/schema/validator.ts';
import { DatasetInputGateError } from '../../../orchestrator-runtime/src/control/dataset-input-gate-store.ts';
import { DocumentInputGateError } from '../../../orchestrator-runtime/src/control/document-input-gate-store.ts';
import { VisualInputGateError } from '../../../orchestrator-runtime/src/control/visual-input-gate-store.ts';
import {
  InvalidScenarioSelectionError,
  planningGuidanceFromStored,
} from '../../../orchestrator-runtime/src/control/requirement-refinement-service.ts';
import type { CurrentPlanningResponse } from './control-planning.ts';
import { requireAuth } from '../middleware.ts';

const currentRequirementValidator = new SchemaValidator();

export interface ControlClarificationPort {
  clarify(input: {
    taskId: string;
    conversationId: string;
    ownerUserId: string;
    answers: Record<string, unknown>;
    assumptionEdits: Record<string, string>;
    selectedScenarioId?: string;
    expectedVersion: number;
    commandReservation: {
      commandType: 'clarification';
      idempotencyKey: string;
      requestHash: string;
      expectedVersion: number;
      reservationToken: string;
      actorUserId: string;
    };
  }, onProgress?: (event: PlanProgress) => void): Promise<CurrentPlanningResponse>;
}

export interface ControlTasksRuntime {
  repository: ControlPlaneRepository;
  workflow: TaskWorkflowService;
  getDeliverable(taskId: string, ownerUserId: string): Promise<unknown | null>;
  getFinalReport?(taskId: string, ownerUserId: string): Promise<{
    artifact: { id: string; contentSha256: string | null };
    report: ControlFinalReport;
  } | null>;
  followUps?: Pick<TaskFollowUpService, 'list' | 'create'>;
  getSkillResults?(taskId: string, ownerUserId: string): Promise<NativeSkillResult[] | null>;
  readFinalReportHtml?(input: {
    taskId: string;
    attemptId: string;
    ownerUserId: string;
  }): Promise<string | null>;
  readFinalReportZip?(input: {
    taskId: string;
    ownerUserId: string;
  }): Promise<Uint8Array | null>;
  readVisualAsset?(input: {
    taskId: string;
    assetId: string;
    ownerUserId: string;
  }): Promise<{
    artifact: { id: string };
    bytes: Uint8Array;
    manifestArtifact?: { schemaVersion: string };
    manifest?: unknown;
    mediaType?: 'image/png' | 'image/jpeg' | 'image/webp';
    inputAsset?: true;
  } | null>;
  readHtmlBundle?(input: {
    taskId: string;
    attemptId: string;
    ownerUserId: string;
  }): Promise<Uint8Array | null>;
  readEditorialSummaryHtml?(input: {
    taskId: string;
    attemptId: string;
    ownerUserId: string;
  }): Promise<string | null>;
  uploadDataset?(input: {
    taskId: string;
    planVersionId: string;
    role: string;
    ownerUserId: string;
    idempotencyKey: string;
    fileName: string;
    mediaType: string;
    bytes: Uint8Array;
    metadata: {
      rowMeaning: string;
      timeRange: string;
      fieldNotes: Record<string, string>;
      units: Record<string, string>;
      sampling: string;
      piiConfirmedAbsent: boolean;
    };
  }): Promise<unknown>;
  uploadDocument?(input: {
    taskId: string;
    planVersionId: string;
    role: string;
    ownerUserId: string;
    idempotencyKey: string;
    files: Array<{ fileName: string; mediaType: string; bytes: Uint8Array }>;
  }): Promise<unknown>;
  uploadVisual?(input: {
    taskId: string;
    planVersionId: string;
    role: string;
    ownerUserId: string;
    idempotencyKey: string;
    files: Array<{ fileName: string; mediaType: string; bytes: Uint8Array }>;
  }): Promise<unknown>;
  clarification?: ControlClarificationPort;
}



function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function clarificationRequirement(value: unknown): ResearchTaskV2 | null {
  const candidate = record(value);
  if (
    !candidate
    || !Array.isArray(candidate.ambiguities)
    || !candidate.ambiguities.every((ambiguity) => {
      const item = record(ambiguity);
      return item !== null && string(item.id) !== null && typeof item.blocking === 'boolean';
    })
    || !Array.isArray(candidate.clarification_questions)
    || !candidate.clarification_questions.every((question) => {
      const item = record(question);
      return item !== null
        && string(item.key) !== null
        && (item.ambiguity_id === undefined || string(item.ambiguity_id) !== null);
    })
    || !Array.isArray(candidate.assumptions)
    || !candidate.assumptions.every((assumption) => {
      const item = record(assumption);
      return item !== null && string(item.key) !== null && typeof item.editable === 'boolean';
    })
  ) return null;
  return candidate as unknown as ResearchTaskV2;
}

function version(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

async function actorFor(req: Request): Promise<WorkflowActor | null> {
  if (!req.userId) return null;
  const user = await getUserById(req.userId);
  if (!user || user.status !== 'active') return null;
  const role = user.role === 'legal' ? 'legal' : user.role === 'security' ? 'security' : user.role === 'gold' ? 'gold' : 'owner';
  return { userId: user.id, role, service: role === 'gold' ? 'gold' : undefined };
}

function idempotencyKey(req: Request): string | null {
  const header = req.header('idempotency-key');
  return string(header) ?? string(record(req.body)?.idempotencyKey);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  const object = record(value);
  if (!object) return value;
  return Object.fromEntries(
    Object.entries(object)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]),
  );
}

function clarificationRequestHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex')}`;
}

async function readApprovalRequirements(
  repository: ControlPlaneRepository,
  task: Awaited<ReturnType<ControlPlaneRepository['getTaskDetail']>>,
  actorRole: WorkflowActor['role'],
): Promise<Array<{
  gateKey: string;
  requiredAuthority: WorkflowActor['role'];
  decision: 'pending' | 'approved' | 'rejected';
  canApprove: boolean;
}>> {
  if (!task?.activePlanVersionId) return [];
  const plan = await repository.getPlanVersionDetail(task.activePlanVersionId);
  if (!plan) return [];
  const gates = await repository.listGateRecords(task.id, plan.id);
  return requiredApprovals(task, plan).map(({ key, authority }) => {
    const approval = gates.find((gate) => (
      gate.gateType === 'approval' && gate.gateKey === key
    ));
    const decision = approval?.decision === 'approved' || approval?.decision === 'rejected'
      ? approval.decision
      : 'pending';
    return {
      gateKey: key,
      requiredAuthority: authority,
      decision,
      canApprove: decision === 'pending' && actorRole === authority,
    };
  });
}

function publicError(error: unknown): {
  status: number;
  body: { error: string; code?: string; kind?: string; retryable?: boolean; unresolved?: unknown };
} {
  if (error instanceof TaskFollowUpError) {
    const status = error.code === 'invalid_request'
      ? 400
      : error.code === 'invalid_model_output' ? 502 : 409;
    return { status, body: { error: error.message, code: error.code } };
  }
  if (error instanceof DatasetInputGateError) {
    return { status: 422, body: { error: 'CSV 文件格式无效或与当前计划不匹配', code: error.code } };
  }
  if (error instanceof DocumentInputGateError) {
    return { status: 422, body: { error: '文档格式无效或与当前计划不匹配', code: error.code } };
  }
  if (error instanceof VisualInputGateError) {
    return { status: 422, body: { error: '图片格式无效或与当前计划不匹配' } };
  }
  if (error instanceof TaskWorkflowGateError) {
    return { status: 422, body: { error: error.message, unresolved: error.unresolved } };
  }
  if (error instanceof TaskWorkflowAuthorizationError) {
    return { status: 403, body: { error: error.message } };
  }
  if (error instanceof LLMInvocationError && error.providerStatus === 429) {
    return {
      status: 429,
      body: {
        error: error.sanitizedMessage,
        kind: error.kind,
        retryable: error.retryable,
      },
    };
  }
  if (error instanceof CandidateProfileNoLongerEligibleError) {
    return { status: 409, body: { error: error.message, code: error.code } };
  }
  if (error instanceof InvalidScenarioSelectionError) {
    return { status: 400, body: { error: error.message, code: error.code } };
  }
  if (error instanceof ControlPlaneConflictError) {
    return { status: 409, body: { error: error.message } };
  }
  return { status: 500, body: { error: '任务处理失败' } };
}

function responseError(res: Response, error: unknown): void {
  const failure = publicError(error);
  res.status(failure.status).json(failure.body);
}

async function authenticatedActor(req: Request, res: Response): Promise<WorkflowActor | null> {
  const actor = await actorFor(req);
  if (!actor) res.status(401).json({ error: '用户不存在或已停用' });
  return actor;
}

async function ensureOwnedTask(
  runtime: ControlTasksRuntime,
  req: Request,
  res: Response,
  actor: WorkflowActor,
  hiddenError = '任务不存在',
): Promise<boolean> {
  const taskId = typeof req.params.id === 'string' ? req.params.id : req.params.id[0] ?? '';
  const task = await runtime.repository.getTaskDetail(taskId);
  if (!task || task.ownerUserId !== actor.userId || task.conversationOwnerUserId !== actor.userId) {
    res.status(404).json({ error: hiddenError });
    return false;
  }
  return true;
}

async function ensureApprovalTaskAccess(
  runtime: ControlTasksRuntime,
  req: Request,
  res: Response,
  actor: WorkflowActor,
  gateKey: string,
): Promise<boolean> {
  const taskId = typeof req.params.id === 'string' ? req.params.id : req.params.id[0] ?? '';
  const task = await runtime.repository.getTaskDetail(taskId);
  if (!task) {
    res.status(404).json({ error: '任务不存在' });
    return false;
  }
  const isOwner = task.ownerUserId === actor.userId
    && task.conversationOwnerUserId === actor.userId;
  if (isOwner) return true;
  const requirements = await readApprovalRequirements(runtime.repository, task, actor.role);
  const isMatchingApprover = task.state === 'awaiting_approval'
    && requirements.some((requirement) => (
      requirement.gateKey === gateKey
      && requirement.requiredAuthority === actor.role
    ));
  if (!isMatchingApprover) {
    res.status(404).json({ error: '任务不存在' });
    return false;
  }
  return true;
}

interface PreparedClarification {
  clarification: ControlClarificationPort;
  actor: WorkflowActor;
  task: NonNullable<Awaited<ReturnType<ControlPlaneRepository['getTaskDetail']>>>;
  expectedVersion: number;
  clarificationAnswers: Record<string, unknown>;
  assumptionEdits: Record<string, string>;
  selectedScenarioId?: string;
  idempotencyKey: string;
  requestHash: string;
}

async function prepareClarification(
  runtime: ControlTasksRuntime,
  req: Request,
  res: Response,
): Promise<PreparedClarification | null> {
  const body = record(req.body);
  const actor = await authenticatedActor(req, res);
  if (!actor) return null;
  if (!runtime.clarification) {
    res.status(501).json({ error: '澄清服务不可用' });
    return null;
  }
  const forbidden = ['plan', 'planHash', 'structuredTask'];
  if (body && forbidden.some((field) => field in body)) {
    res.status(400).json({ error: 'plan、planHash、structuredTask 由服务端生成，不接受客户端提交' });
    return null;
  }
  const expectedVersion = version(body?.expectedVersion);
  const clarificationAnswers = record(body?.clarificationAnswers);
  const assumptionEdits = record(body?.assumptionEdits);
  const hasSelectedScenarioId = body !== null && Object.hasOwn(body, 'selectedScenarioId');
  const selectedScenarioId = string(body?.selectedScenarioId);
  const key = idempotencyKey(req);
  if (
    expectedVersion == null
    || !clarificationAnswers
    || !assumptionEdits
    || !key
    || (hasSelectedScenarioId && !selectedScenarioId)
    || Object.values(assumptionEdits).some((value) => typeof value !== 'string')
  ) {
    res.status(400).json({ error: 'expectedVersion、clarificationAnswers、assumptionEdits、Idempotency-Key 必填' });
    return null;
  }

  const taskId = typeof req.params.id === 'string' ? req.params.id : req.params.id[0] ?? '';
  const task = await runtime.repository.getTaskDetail(taskId);
  if (!task || task.ownerUserId !== actor.userId || task.conversationOwnerUserId !== actor.userId) {
    res.status(404).json({ error: '任务不存在' });
    return null;
  }
  const requestHash = clarificationRequestHash({
    expectedVersion,
    clarificationAnswers,
    assumptionEdits,
    ...(selectedScenarioId ? { selectedScenarioId } : {}),
  });
  const existingCommand = await runtime.repository.getCommand(task.id, 'clarification', key);
  const resumesExistingCommand = existingCommand?.requestHash === requestHash;
  if (task.state === 'awaiting_clarification' && !resumesExistingCommand) {
    const requirement = clarificationRequirement(task.structuredTask);
    if (!requirement) {
      res.status(409).json({ error: `awaiting_clarification task ${task.id} has invalid clarification requirement` });
      return null;
    }
    const questionKeys = new Set(requirement.clarification_questions.map(({ key: questionKey }) => questionKey));
    const unknownAnswerKeys = Object.keys(clarificationAnswers).filter((answerKey) => !questionKeys.has(answerKey));
    if (unknownAnswerKeys.length > 0) {
      res.status(400).json({ error: 'clarificationAnswers contains unknown keys', unknown: unknownAnswerKeys });
      return null;
    }
    const invalidAnswerKeys = Object.entries(clarificationAnswers)
      .filter(([, value]) => !isExplicitClarificationAnswer(value))
      .map(([answerKey]) => answerKey);
    if (invalidAnswerKeys.length > 0) {
      res.status(400).json({ error: 'clarificationAnswers contains empty values', invalid: invalidAnswerKeys });
      return null;
    }
    const assumptions = new Map(requirement.assumptions.map((assumption) => [assumption.key, assumption]));
    const invalidAssumptionKeys = Object.keys(assumptionEdits).filter((assumptionKey) => {
      const assumption = assumptions.get(assumptionKey);
      return !assumption?.editable;
    });
    if (invalidAssumptionKeys.length > 0) {
      res.status(400).json({ error: 'assumptionEdits contains unknown or locked keys', invalid: invalidAssumptionKeys });
      return null;
    }
    const missing = missingRequiredClarificationAnswers(requirement, clarificationAnswers);
    if (missing.length > 0) {
      res.status(422).json({
        error: 'required clarification answers are missing',
        unresolved: missing,
      });
      return null;
    }
  }
  if (task.state !== 'awaiting_clarification') {
    if (!existingCommand || existingCommand.requestHash !== requestHash) {
      res.status(409).json({ error: `task ${task.id} is not awaiting_clarification` });
      return null;
    }
  }
  return {
    clarification: runtime.clarification,
    actor,
    task,
    expectedVersion,
    clarificationAnswers,
    assumptionEdits: Object.fromEntries(
      Object.entries(assumptionEdits).map(([field, value]) => [field, value as string]),
    ),
    ...(selectedScenarioId ? { selectedScenarioId } : {}),
    idempotencyKey: key,
    requestHash,
  };
}

async function runClarification(
  runtime: ControlTasksRuntime,
  prepared: PreparedClarification,
  onProgress?: (event: PlanProgress) => void,
): Promise<CurrentPlanningResponse> {
  const command = {
    taskId: prepared.task.id,
    commandType: 'clarification' as const,
    idempotencyKey: prepared.idempotencyKey,
    requestHash: prepared.requestHash,
    expectedVersion: prepared.expectedVersion,
  };
  let reservationToken: string | null = null;
  while (!reservationToken) {
    const reservation = await runtime.repository.reserveCommand({
      ...command,
      actorUserId: prepared.actor.userId,
    });
    if (reservation.status === 'conflict') {
      throw new ControlPlaneConflictError(
        `idempotency key ${prepared.idempotencyKey} was reused with a different request`,
      );
    }
    if (reservation.status === 'replay') {
      return reservation.response as CurrentPlanningResponse;
    }
    if (reservation.status === 'pending') {
      const waited = await runtime.repository.waitForCommand(command);
      if (waited.status === 'conflict') {
        throw new ControlPlaneConflictError(
          `idempotency key ${prepared.idempotencyKey} was reused with a different request`,
        );
      }
      if (waited.status === 'replay') {
        return waited.response as CurrentPlanningResponse;
      }
      continue;
    }
    reservationToken = reservation.reservationToken;
  }

  try {
    const response = await prepared.clarification.clarify({
      taskId: prepared.task.id,
      conversationId: prepared.task.conversationId,
      ownerUserId: prepared.actor.userId,
      answers: prepared.clarificationAnswers,
      assumptionEdits: prepared.assumptionEdits,
      ...(prepared.selectedScenarioId ? { selectedScenarioId: prepared.selectedScenarioId } : {}),
      expectedVersion: prepared.expectedVersion,
      commandReservation: {
        ...command,
        reservationToken,
        actorUserId: prepared.actor.userId,
      },
    }, onProgress);
    if (response.status === 'clarification_required') {
      await runtime.repository.completeCommand({
        ...command,
        reservationToken,
        stateAfter: response.task.state,
        response,
      });
    }
    return response;
  } catch (error) {
    await runtime.repository.recoverCommandAfterFailure({ ...command, reservationToken });
    throw error;
  }
}

interface ParsedDatasetUpload {
  fileName: string;
  mediaType: string;
  bytes: Buffer;
  metadata: {
    rowMeaning: string;
    timeRange: string;
    fieldNotes: Record<string, string>;
    units: Record<string, string>;
    sampling: string;
    piiConfirmedAbsent: boolean;
  };
}

function parseDatasetMetadata(value: string): ParsedDatasetUpload['metadata'] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new DatasetInputGateError('metadata must be valid JSON');
  }
  const candidate = record(parsed);
  if (
    !candidate
    || typeof candidate.rowMeaning !== 'string'
    || typeof candidate.timeRange !== 'string'
    || typeof candidate.sampling !== 'string'
    || typeof candidate.piiConfirmedAbsent !== 'boolean'
    || !record(candidate.fieldNotes)
    || !record(candidate.units)
  ) throw new DatasetInputGateError('metadata fields are malformed');
  const stringRecord = (value: Record<string, unknown>, field: string): Record<string, string> => {
    if (Object.values(value).some((item) => typeof item !== 'string')) {
      throw new DatasetInputGateError(`${field} must contain only string values`);
    }
    return value as Record<string, string>;
  };
  return {
    rowMeaning: candidate.rowMeaning,
    timeRange: candidate.timeRange,
    fieldNotes: stringRecord(record(candidate.fieldNotes)!, 'fieldNotes'),
    units: stringRecord(record(candidate.units)!, 'units'),
    sampling: candidate.sampling,
    piiConfirmedAbsent: candidate.piiConfirmedAbsent,
  };
}

function readDatasetMultipart(req: Request): Promise<ParsedDatasetUpload> {
  return new Promise((resolve, reject) => {
    let parser: ReturnType<typeof Busboy>;
    try {
      parser = Busboy({ headers: req.headers, limits: { files: 1, fields: 1, fileSize: 10 * 1024 * 1024 } });
    } catch (error) {
      reject(new DatasetInputGateError(error instanceof Error ? error.message : 'invalid multipart request'));
      return;
    }
    let fileName: string | null = null;
    let mediaType: string | null = null;
    let fileSeen = false;
    let fileTooLarge = false;
    let metadataText: string | null = null;
    const chunks: Buffer[] = [];
    parser.on('file', (fieldName, stream, info) => {
      if (fieldName !== 'file' || fileSeen) {
        stream.resume();
        reject(new DatasetInputGateError('multipart request must contain exactly one file field'));
        return;
      }
      fileSeen = true;
      fileName = info.filename;
      mediaType = info.mimeType;
      stream.on('limit', () => { fileTooLarge = true; });
      stream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      stream.on('error', reject);
    });
    parser.on('field', (fieldName, value) => {
      if (fieldName !== 'metadata' || metadataText !== null) {
        reject(new DatasetInputGateError('multipart request must contain one metadata field'));
        return;
      }
      metadataText = value;
    });
    parser.on('error', reject);
    parser.on('finish', () => {
      try {
        if (!fileSeen || !fileName || !mediaType || fileTooLarge) {
          throw new DatasetInputGateError(fileTooLarge ? 'CSV byte size exceeds 10 MiB' : 'file field is required');
        }
        if (metadataText === null) throw new DatasetInputGateError('metadata field is required');
        resolve({
          fileName,
          mediaType,
          bytes: Buffer.concat(chunks),
          metadata: parseDatasetMetadata(metadataText),
        });
      } catch (error) {
        reject(error);
      }
    });
    req.pipe(parser);
  });
}

interface ParsedMaterialFiles {
  files: Array<{ fileName: string; mediaType: string; bytes: Buffer }>;
}

function readMaterialFilesMultipart(
  req: Request,
  invalid: (message: string) => Error,
): Promise<ParsedMaterialFiles> {
  return new Promise((resolve, reject) => {
    let parser: ReturnType<typeof Busboy>;
    try {
      parser = Busboy({ headers: req.headers, limits: { files: 20, fields: 0, fileSize: 10 * 1024 * 1024 } });
    } catch (error) {
      reject(invalid(error instanceof Error ? error.message : 'invalid multipart request'));
      return;
    }
    const files: Array<{ index: number; fileName: string; mediaType: string; chunks: Buffer[]; tooLarge: boolean }> = [];
    let rejected = false;
    parser.on('file', (fieldName, stream, info) => {
      if (fieldName !== 'file') {
        stream.resume();
        rejected = true;
        reject(invalid('multipart request only accepts file fields'));
        return;
      }
      const file = {
        index: files.length,
        fileName: info.filename,
        mediaType: info.mimeType,
        chunks: [] as Buffer[],
        tooLarge: false,
      };
      files.push(file);
      stream.on('limit', () => { file.tooLarge = true; });
      stream.on('data', (chunk: Buffer) => file.chunks.push(Buffer.from(chunk)));
      stream.on('error', reject);
    });
    parser.on('field', () => {
      rejected = true;
      reject(invalid('multipart request does not accept text fields'));
    });
    parser.on('filesLimit', () => {
      rejected = true;
      reject(invalid('file count exceeds 20 files'));
    });
    parser.on('error', reject);
    parser.on('finish', () => {
      if (rejected) return;
      try {
        if (files.length === 0) throw invalid('at least one file field is required');
        const oversized = files.find(({ tooLarge }) => tooLarge);
        if (oversized) throw invalid(`file ${oversized.fileName} exceeds 10 MiB`);
        resolve({
          files: files
            .sort((left, right) => left.index - right.index)
            .map(({ fileName, mediaType, chunks }) => ({
              fileName,
              mediaType,
              bytes: Buffer.concat(chunks),
            })),
        });
      } catch (error) {
        reject(error);
      }
    });
    req.pipe(parser);
  });
}

export function createControlTasksRouter(runtime: ControlTasksRuntime): Router {
  const router = Router();
  router.use(requireAuth);
  const { repository, workflow } = runtime;
  router.get('/', async (req, res) => {
    const actor = await authenticatedActor(req, res);
    if (!actor) return;
    try {
      const tasks = await repository.listTasksForOwner({ ownerUserId: actor.userId });
      res.json({ kind: 'current', tasks });
    } catch (error) {
      responseError(res, error);
    }
  });

  router.post('/:id/clarify/stream', async (req, res) => {
    try {
      const prepared = await prepareClarification(runtime, req, res);
      if (!prepared) return;

      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
      const send = (event: string, data: unknown): void => {
        if (res.destroyed || res.writableEnded) return;
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      const heartbeat = setInterval(() => {
        if (!res.destroyed && !res.writableEnded) res.write(': keep-alive\n\n');
      }, 15_000);
      heartbeat.unref();

      try {
        const response = await runClarification(runtime, prepared, (event) => {
          send('progress', event);
        });
        send('result', response);
      } catch (error) {
        const failure = publicError(error);
        send('error', { ...failure.body, status: failure.status });
      } finally {
        clearInterval(heartbeat);
        if (!res.writableEnded) res.end();
      }
    } catch (error) {
      if (!res.headersSent) responseError(res, error);
      else if (!res.writableEnded) res.end();
    }
  });

  router.post('/:id/clarify', async (req, res) => {
    try {
      const prepared = await prepareClarification(runtime, req, res);
      if (!prepared) return;
      res.json(await runClarification(runtime, prepared));
    } catch (error) {
      responseError(res, error);
    }
  });

  router.get('/:id/skill-results', async (req, res) => {
    const actor = await authenticatedActor(req, res);
    if (!actor) return;
    if (!await ensureOwnedTask(runtime, req, res, actor, '报告不存在')) return;
    if (!runtime.getSkillResults) {
      res.status(409).json({ error: 'Skill 报告不可用' });
      return;
    }
    try {
      const results = await runtime.getSkillResults(req.params.id, actor.userId);
      if (!results) {
        res.status(404).json({ error: '报告不存在' });
        return;
      }
      res.json({ results });
    } catch (error) {
      responseError(res, error);
    }
  });

  router.get('/:id/final-report', async (req, res) => {
    const actor = await authenticatedActor(req, res);
    if (!actor) return;
    if (!await ensureOwnedTask(runtime, req, res, actor, '报告不存在')) return;
    if (!runtime.getFinalReport) {
      res.status(409).json({ error: '最终报告不可用' });
      return;
    }
    try {
      const result = await runtime.getFinalReport(req.params.id, actor.userId);
      if (!result) {
        res.status(404).json({ error: '报告不存在' });
        return;
      }
      res.json(result.report);
    } catch (error) {
      responseError(res, error);
    }
  });

  router.get('/:id/follow-ups', async (req, res) => {
    const actor = await authenticatedActor(req, res);
    if (!actor) return;
    if (!runtime.followUps) {
      res.status(503).json({ error: '报告追问暂不可用' });
      return;
    }
    if (!await ensureOwnedTask(runtime, req, res, actor, '报告不存在')) return;
    try {
      const taskId = typeof req.params.id === 'string' ? req.params.id : req.params.id[0] ?? '';
      res.json({ messages: await runtime.followUps.list({ taskId, ownerUserId: actor.userId }) });
    } catch (error) {
      responseError(res, error);
    }
  });

  router.post('/:id/follow-ups', async (req, res) => {
    const actor = await authenticatedActor(req, res);
    const key = idempotencyKey(req);
    if (!actor) return;
    if (!runtime.followUps || !runtime.getFinalReport) {
      res.status(503).json({ error: '报告追问暂不可用' });
      return;
    }
    const message = string(record(req.body)?.message);
    if (!key || !message) {
      res.status(400).json({ error: '追问内容和 Idempotency-Key 必填' });
      return;
    }
    const taskId = typeof req.params.id === 'string' ? req.params.id : req.params.id[0] ?? '';
    try {
      const task = await runtime.repository.getTaskDetail(taskId);
      if (!task || task.ownerUserId !== actor.userId || task.conversationOwnerUserId !== actor.userId) {
        res.status(404).json({ error: '报告不存在' });
        return;
      }
      const report = await runtime.getFinalReport(taskId, actor.userId);
      if (!report) {
        res.status(409).json({ error: '任务尚未生成最终报告' });
        return;
      }
      const response: TaskFollowUpResponse = await runtime.followUps.create({
        task,
        report,
        ownerUserId: actor.userId,
        message,
        idempotencyKey: key,
      });
      res.set('Idempotency-Key', key).json(response);
    } catch (error) {
      responseError(res, error);
    }
  });

  router.get('/:id/final-report.html', async (req, res) => {
    const actor = await authenticatedActor(req, res);
    if (!actor) return;
    if (!await ensureOwnedTask(runtime, req, res, actor, '报告不存在')) return;
    if (!runtime.getFinalReport || !runtime.readFinalReportHtml) {
      res.status(409).json({ error: '最终 HTML 报告不可用' });
      return;
    }
    try {
      const final = await runtime.getFinalReport(req.params.id, actor.userId);
      if (!final) {
        res.status(404).json({ error: '报告不存在' });
        return;
      }
      const html = await runtime.readFinalReportHtml({
        taskId: req.params.id,
        attemptId: final.report.attemptId,
        ownerUserId: actor.userId,
      });
      if (!html) {
        res.status(404).json({ error: '报告不存在' });
        return;
      }
      res.set({
        'Cache-Control': 'private, no-store',
        'Content-Disposition': 'inline; filename="report.html"',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; img-src 'self' blob:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        'Content-Type': 'text/html; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      });
      res.send(html);
    } catch (error) {
      responseError(res, error);
    }
  });

  router.get('/:id/final-report.zip', async (req, res) => {
    const actor = await authenticatedActor(req, res);
    if (!actor) return;
    if (!await ensureOwnedTask(runtime, req, res, actor, '报告不存在')) return;
    if (!runtime.readFinalReportZip) {
      res.status(409).json({ error: '离线报告暂不可用' });
      return;
    }
    try {
      const bytes = await runtime.readFinalReportZip({
        taskId: req.params.id,
        ownerUserId: actor.userId,
      });
      if (!bytes) {
        res.status(404).json({ error: '离线报告不存在' });
        return;
      }
      res.set({
        'Cache-Control': 'private, no-store',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent('研究报告.zip')}`,
        'Content-Type': 'application/zip',
        'X-Content-Type-Options': 'nosniff',
      });
      res.send(Buffer.from(bytes));
    } catch (error) {
      responseError(res, error);
    }
  });

  router.get('/:id/assets/:assetId', async (req, res) => {
    const actor = await authenticatedActor(req, res);
    if (!actor) return;
    const hidden = () => res.status(404).json({ error: '资源不存在' });
    if (!await ensureOwnedTask(runtime, req, res, actor, '资源不存在')) return;
    if (!runtime.readVisualAsset) {
      hidden();
      return;
    }
    try {
      const asset = await runtime.readVisualAsset({
        taskId: req.params.id,
        assetId: req.params.assetId,
        ownerUserId: actor.userId,
      });
      if (!asset || asset.artifact.id !== req.params.assetId) {
        hidden();
        return;
      }
      let mediaType: string;
      if (asset.inputAsset === true) {
        if (
          asset.mediaType !== 'image/png'
          && asset.mediaType !== 'image/jpeg'
          && asset.mediaType !== 'image/webp'
        ) {
          hidden();
          return;
        }
        mediaType = asset.mediaType;
      } else {
        if (!asset.manifest || !asset.manifestArtifact) {
          hidden();
          return;
        }
        assertVisualAssetManifestSchema(asset.manifest);
        const manifest: VisualAssetManifest = asset.manifest;
        if (
          manifest.assetId !== req.params.assetId
          || asset.manifestArtifact.schemaVersion !== manifest.version
        ) {
          hidden();
          return;
        }
        mediaType = manifest.mediaType;
      }
      res.set({
        'Cache-Control': 'private, no-store',
        'Content-Disposition': 'inline',
        'Content-Type': mediaType,
      });
      res.send(Buffer.from(asset.bytes));
    } catch {
      hidden();
    }
  });

  router.get('/:id/reports/:attemptId/html-bundle', async (req, res) => {
    const actor = await authenticatedActor(req, res);
    if (!actor) return;
    if (!await ensureOwnedTask(runtime, req, res, actor, '报告不存在')) return;
    if (!runtime.readHtmlBundle) {
      res.status(409).json({ error: '离线 HTML 报告不可用', code: 'html_bundle_unavailable' });
      return;
    }
    try {
      const bytes = await runtime.readHtmlBundle({
        taskId: req.params.id,
        attemptId: req.params.attemptId,
        ownerUserId: actor.userId,
      });
      if (!bytes) {
        res.status(404).json({ error: '报告不存在' });
        return;
      }
      res.set({
        'Cache-Control': 'private, no-store',
        'Content-Disposition': 'attachment; filename="report-bundle.zip"',
        'Content-Type': 'application/zip',
        'X-Content-Type-Options': 'nosniff',
      });
      res.send(Buffer.from(bytes));
    } catch (error) {
      if (error instanceof HtmlBundleUnavailableError) {
        res.status(409).json({ error: '离线 HTML 报告不可用', code: error.code });
        return;
      }
      if (error instanceof HtmlBundleIntegrityError) {
        res.status(409).json({ error: '离线 HTML 报告完整性校验失败', code: error.code });
        return;
      }
      responseError(res, error);
    }
  });

  router.get('/:id/reports/:attemptId/editorial-summary.html', async (req, res) => {
    const actor = await authenticatedActor(req, res);
    if (!actor) return;
    if (!await ensureOwnedTask(runtime, req, res, actor, '报告不存在')) return;
    if (!runtime.readEditorialSummaryHtml) {
      res.status(409).json({ error: '编辑摘要不可用', code: 'editorial_summary_unavailable' });
      return;
    }
    try {
      const html = await runtime.readEditorialSummaryHtml({
        taskId: req.params.id,
        attemptId: req.params.attemptId,
        ownerUserId: actor.userId,
      });
      if (!html) {
        res.status(404).json({ error: '报告不存在' });
        return;
      }
      res.set({
        'Cache-Control': 'private, no-store',
        'Content-Disposition': 'inline; filename="editorial-summary.html"',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        'Content-Type': 'text/html; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      });
      res.send(html);
    } catch (error) {
      if (error instanceof EditorialSummaryPipelineError) {
        const unavailable = error.code === 'SUMMARY_MODEL_UNAVAILABLE';
        res.status(409).json({
          error: unavailable ? '编辑摘要模型不可用' : '编辑摘要生成失败',
          code: unavailable ? 'editorial_summary_unavailable' : 'editorial_summary_generation_failed',
        });
        return;
      }
      if (error instanceof EditorialSummaryStoreError) {
        res.status(409).json({ error: '编辑摘要完整性校验失败', code: 'editorial_summary_integrity' });
        return;
      }
      if (error instanceof HtmlBundleUnavailableError) {
        res.status(409).json({ error: '编辑摘要不可用', code: 'editorial_summary_unavailable' });
        return;
      }
      responseError(res, error);
    }
  });

  router.get('/approvals', async (req, res) => {
    const actor = await authenticatedActor(req, res);
    if (!actor) return;
    try {
      const tasks = await repository.listTasksAwaitingApproval();
      const summaries = [];
      for (const task of tasks) {
        const approvals = await readApprovalRequirements(repository, task, actor.role);
        if (!approvals.some((approval) => approval.canApprove || approval.requiredAuthority === actor.role)) continue;
        const structuredTask = task.structuredTask;
        const taskType = record(structuredTask)?.task_type;
        summaries.push({
          id: task.id,
          originalInput: task.originalInput,
          taskType: typeof taskType === 'string' ? taskType : null,
          state: task.state,
          stateVersion: task.stateVersion,
          activePlanVersionId: task.activePlanVersionId,
        });
      }
      res.json({ tasks: summaries });
    } catch (error) {
      responseError(res, error);
    }
  });

router.get('/:id', async (req, res) => {
  const actor = await authenticatedActor(req, res);
  if (!actor) return;
  const task = await repository.getTaskDetail(req.params.id);
  if (!task) {
    res.status(404).json({ error: '任务不存在' });
    return;
  }
  try {
    const isOwner = task.ownerUserId === actor.userId
      && task.conversationOwnerUserId === actor.userId;
    const approvalRequirements = await readApprovalRequirements(repository, task, actor.role);
    const canReviewAsApprover = task.state === 'awaiting_approval'
      && approvalRequirements.some((approval) => approval.requiredAuthority === actor.role);
    if (!isOwner && !canReviewAsApprover) {
      res.status(404).json({ error: '任务不存在' });
      return;
    }
    if (task.state === 'awaiting_clarification') {
      const errors = currentRequirementValidator.validate('research-task-v2', task.structuredTask);
      if (errors.length > 0) {
        throw new ControlPlaneConflictError(
          `awaiting_clarification task ${task.id} has invalid research-task-v2`,
        );
      }
    }
    const [recovered, activePlan, executionSteps, pendingInputQuarantined, activeRequirement] = await Promise.all([
      task.state === 'awaiting_selection'
        ? isOwner
          ? repository.listCandidatePlanVersionsForOwner({
            taskId: task.id,
            ownerUserId: actor.userId,
          })
          : Promise.resolve({ candidates: [], activatedNodes: [] })
        : Promise.resolve({ candidates: [], activatedNodes: [] }),
      task.activePlanVersionId
        ? isOwner
          ? repository.getActivePlanForOwner({ taskId: task.id, ownerUserId: actor.userId })
          : repository.getActivePlan(task.id)
        : Promise.resolve(null),
      task.currentAttemptId
        ? repository.listExecutionSteps(task.currentAttemptId)
        : Promise.resolve([]),
      task.activePlanVersionId && isOwner
        ? repository.isPlanPendingInputQuarantined(task.activePlanVersionId)
        : Promise.resolve(false),
      task.state === 'awaiting_clarification' && isOwner
        ? repository.getActiveRequirementVersion(task.id)
        : Promise.resolve(null),
    ]);
    if (!recovered) {
      res.status(404).json({ error: '任务不存在' });
      return;
    }
    const planningGuidance = planningGuidanceFromStored(activeRequirement?.clarification);
    res.json({
      kind: 'current',
      task,
      activePlan,
      executionSteps: executionSteps.map((step) => ({
        stepNo: step.stepNo,
        stepName: step.stepName,
        actorType: step.actorType,
        actorId: step.actorId,
        state: step.state,
        outputArtifactId: step.outputArtifactId,
        toolProvenance: step.toolProvenance,
        skillProvenance: step.skillProvenance,
        failure: step.failure,
        latencyMs: step.latencyMs,
      })),
      approvalRequirements,
      ...(planningGuidance ? { planningGuidance } : {}),
      ...(pendingInputQuarantined
        ? { planRecovery: { kind: 'plan_revision_required' as const, reason: 'legacy_pending_inputs' as const } }
        : {}),
      ...recovered,
    });
  } catch (error) {
    responseError(res, error);
  }
});

router.get('/:id/deliverable', async (req, res) => {
  const actor = await authenticatedActor(req, res);
  if (!actor) return;
  try {
    const deliverable = await runtime.getDeliverable(req.params.id, actor.userId);
    if (deliverable === null) {
      res.status(404).json({ error: '交付物不存在' });
      return;
    }
    res.json(deliverable);
  } catch (error) {
    responseError(res, error);
  }
});

router.post('/:id/select', async (req, res) => {
  const body = record(req.body);
  const actor = await authenticatedActor(req, res);
  const key = idempotencyKey(req);
  const expectedVersion = version(body?.expectedVersion);
  const planVersionId = string(body?.planVersionId);
  if (!actor) return;
  if (!await ensureOwnedTask(runtime, req, res, actor)) return;
  if (expectedVersion == null || !key || !planVersionId) {
    res.status(400).json({ error: 'expectedVersion、Idempotency-Key、planVersionId 必填' });
    return;
  }
  try {
    res.json(await workflow.select({
      taskId: req.params.id,
      expectedVersion,
      idempotencyKey: key,
      actor,
      planVersionId,
    }));
  } catch (error) {
    responseError(res, error);
  }
});

router.post('/:id/plans/:planVersionId/inputs/:role/dataset', async (req, res) => {
  const actor = await authenticatedActor(req, res);
  const key = idempotencyKey(req);
  if (!actor) return;
  if (!runtime.uploadDataset) {
    res.status(503).json({ error: 'Dataset input is unavailable' });
    return;
  }
  if (!key) {
    res.status(400).json({ error: 'Idempotency-Key 必填' });
    return;
  }
  if (!await ensureOwnedTask(runtime, req, res, actor)) return;
  const taskId = typeof req.params.id === 'string' ? req.params.id : req.params.id[0] ?? '';
  const planVersionId = typeof req.params.planVersionId === 'string'
    ? req.params.planVersionId
    : req.params.planVersionId[0] ?? '';
  const role = typeof req.params.role === 'string' ? req.params.role : req.params.role[0] ?? '';
  try {
    const upload = await readDatasetMultipart(req);
    const result = await runtime.uploadDataset({
      taskId,
      planVersionId,
      role,
      ownerUserId: actor.userId,
      idempotencyKey: key,
      fileName: upload.fileName,
      mediaType: upload.mediaType,
      bytes: upload.bytes,
      metadata: upload.metadata,
    });
    res.status(201).set('Idempotency-Key', key).json(result);
  } catch (error) {
    responseError(res, error);
  }
});

router.post('/:id/plans/:planVersionId/inputs/:role/document', async (req, res) => {
  const actor = await authenticatedActor(req, res);
  const key = idempotencyKey(req);
  if (!actor) return;
  if (!runtime.uploadDocument) {
    res.status(503).json({ error: '文档上传暂不可用' });
    return;
  }
  if (!key) {
    res.status(400).json({ error: 'Idempotency-Key 必填' });
    return;
  }
  if (!await ensureOwnedTask(runtime, req, res, actor)) return;
  const taskId = typeof req.params.id === 'string' ? req.params.id : req.params.id[0] ?? '';
  const planVersionId = typeof req.params.planVersionId === 'string'
    ? req.params.planVersionId
    : req.params.planVersionId[0] ?? '';
  const role = typeof req.params.role === 'string' ? req.params.role : req.params.role[0] ?? '';
  try {
    const upload = await readMaterialFilesMultipart(
      req,
      (message) => new DocumentInputGateError(message),
    );
    const result = await runtime.uploadDocument({
      taskId,
      planVersionId,
      role,
      ownerUserId: actor.userId,
      idempotencyKey: key,
      files: upload.files,
    });
    res.status(201).set('Idempotency-Key', key).json(result);
  } catch (error) {
    responseError(res, error);
  }
});

router.post('/:id/plans/:planVersionId/inputs/:role/visual', async (req, res) => {
  const actor = await authenticatedActor(req, res);
  const key = idempotencyKey(req);
  if (!actor) return;
  if (!runtime.uploadVisual) {
    res.status(503).json({ error: '图片上传暂不可用' });
    return;
  }
  if (!key) {
    res.status(400).json({ error: 'Idempotency-Key 必填' });
    return;
  }
  if (!await ensureOwnedTask(runtime, req, res, actor)) return;
  const taskId = typeof req.params.id === 'string' ? req.params.id : req.params.id[0] ?? '';
  const planVersionId = typeof req.params.planVersionId === 'string'
    ? req.params.planVersionId
    : req.params.planVersionId[0] ?? '';
  const role = typeof req.params.role === 'string' ? req.params.role : req.params.role[0] ?? '';
  try {
    const upload = await readMaterialFilesMultipart(
      req,
      (message) => new VisualInputGateError(message),
    );
    const result = await runtime.uploadVisual({
      taskId,
      planVersionId,
      role,
      ownerUserId: actor.userId,
      idempotencyKey: key,
      files: upload.files,
    });
    res.status(201).set('Idempotency-Key', key).json(result);
  } catch (error) {
    responseError(res, error);
  }
});

router.post('/:id/confirm', async (req, res) => {
  const body = record(req.body);
  const actor = await authenticatedActor(req, res);
  const key = idempotencyKey(req);
  const expectedVersion = version(body?.expectedVersion);
  const planVersionId = string(body?.planVersionId);
  const confirmationAnswers = record(body?.confirmationAnswers);
  const inputValues = record(body?.inputValues);
  const waivedInputKeys = Array.isArray(body?.waivedInputKeys)
    && body.waivedInputKeys.every((key) => typeof key === 'string' && key.trim())
    ? body.waivedInputKeys as string[]
    : body?.waivedInputKeys === undefined ? [] : null;
  if (!actor) return;
  if (!await ensureOwnedTask(runtime, req, res, actor)) return;
  if (expectedVersion == null || !key || !planVersionId || !confirmationAnswers || !inputValues || !waivedInputKeys) {
    res.status(400).json({ error: 'expectedVersion、Idempotency-Key、planVersionId、confirmationAnswers、inputValues 必填，waivedInputKeys 必须是字符串数组' });
    return;
  }
  try {
    res.json(await workflow.confirm({
      taskId: req.params.id,
      planVersionId,
      expectedVersion,
      idempotencyKey: key,
      actor,
      confirmationAnswers,
      inputValues,
      waivedInputKeys,
    }));
  } catch (error) {
    responseError(res, error);
  }
});

router.post('/:id/approve', async (req, res) => {
  const body = record(req.body);
  const actor = await authenticatedActor(req, res);
  const key = idempotencyKey(req);
  const expectedVersion = version(body?.expectedVersion);
  const planVersionId = string(body?.planVersionId);
  const gateKey = string(body?.gateKey);
  const decision = body?.decision === 'approved' || body?.decision === 'rejected' ? body.decision : null;
  if (!actor) return;
  if (!await ensureApprovalTaskAccess(runtime, req, res, actor, gateKey ?? '')) return;
  if (expectedVersion == null || !key || !planVersionId || !gateKey || !decision) {
    res.status(400).json({ error: 'expectedVersion、Idempotency-Key、planVersionId、gateKey、decision 必填' });
    return;
  }
  try {
    res.json(await workflow.approve({
      taskId: req.params.id,
      planVersionId,
      expectedVersion,
      idempotencyKey: key,
      actor,
      gateKey,
      decision,
    }));
  } catch (error) {
    responseError(res, error);
  }
});

router.post('/:id/revise', async (req, res) => {
  const body = record(req.body);
  const actor = await authenticatedActor(req, res);
  const key = idempotencyKey(req);
  const expectedVersion = version(body?.expectedVersion);
  const revisionInstruction = string(body?.revisionInstruction);
  if (!actor) return;
  if (!await ensureOwnedTask(runtime, req, res, actor)) return;
  if (body && ('plan' in body || 'planHash' in body)) {
    res.status(400).json({ error: 'plan 和 planHash 由服务端生成，不接受客户端提交' });
    return;
  }
  if (expectedVersion == null || !key || !revisionInstruction) {
    res.status(400).json({ error: 'expectedVersion、Idempotency-Key、revisionInstruction 必填' });
    return;
  }
  try {
    res.json(await workflow.revise({
      taskId: req.params.id,
      expectedVersion,
      idempotencyKey: key,
      actor,
      revisionInstruction,
    }));
  } catch (error) {
    responseError(res, error);
  }
});

router.post('/:id/cancel', async (req, res) => {
  const body = record(req.body);
  const actor = await authenticatedActor(req, res);
  const key = idempotencyKey(req);
  const expectedVersion = version(body?.expectedVersion);
  if (!actor) return;
  if (!await ensureOwnedTask(runtime, req, res, actor)) return;
  if (expectedVersion == null || !key) {
    res.status(400).json({ error: 'expectedVersion、Idempotency-Key 必填' });
    return;
  }
  try {
    res.json(await workflow.cancel({
      taskId: req.params.id,
      expectedVersion,
      idempotencyKey: key,
      actor,
    }));
  } catch (error) {
    responseError(res, error);
  }
});

router.post('/:id/resume', async (req, res) => {
  const body = record(req.body);
  const actor = await authenticatedActor(req, res);
  const key = idempotencyKey(req);
  const expectedVersion = version(body?.expectedVersion);
  const action = body?.action === 'retry' || body?.action === 'skip' || body?.action === 'abort'
    ? body.action
    : undefined;
  const failedStepNo = version(body?.failedStepNo);
  if (body?.action !== undefined && !action) {
    res.status(400).json({ error: 'action 需为 retry、skip 或 abort' });
    return;
  }
  if (body?.failedStepNo !== undefined && (!failedStepNo || failedStepNo < 1)) {
    res.status(400).json({ error: 'failedStepNo 需为正整数' });
    return;
  }
  if (!actor) return;
  if (!await ensureOwnedTask(runtime, req, res, actor)) return;
  if (expectedVersion == null || !key) {
    res.status(400).json({ error: 'expectedVersion、Idempotency-Key 必填' });
    return;
  }
  try {
    res.json(await workflow.resume({
      taskId: req.params.id,
      expectedVersion,
      idempotencyKey: key,
      actor,
      action,
      failedStepNo: failedStepNo && failedStepNo > 0 ? failedStepNo : undefined,
    }));
  } catch (error) {
    responseError(res, error);
  }
});

router.post('/:id/execute', async (req, res) => {
  const body = record(req.body);
  const actor = await authenticatedActor(req, res);
  const key = idempotencyKey(req);
  const expectedVersion = version(body?.expectedVersion);
  const planVersionId = string(body?.planVersionId);
  if (!actor) return;
  if (!await ensureOwnedTask(runtime, req, res, actor)) return;
  if (expectedVersion == null || !key || !planVersionId) {
    res.status(400).json({ error: 'expectedVersion、Idempotency-Key、planVersionId 必填' });
    return;
  }
  try {
    res.json(await workflow.execute({
      taskId: req.params.id,
      planVersionId,
      expectedVersion,
      idempotencyKey: key,
      actor,
    }));
  } catch (error) {
    responseError(res, error);
  }
});

  return router;
}
