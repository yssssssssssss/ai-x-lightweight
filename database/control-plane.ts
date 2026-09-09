import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { MigrationConnection, MigrationDatabase } from './migration-runner.ts';
import {
  executionFailureAllowsAction,
  selectAuthoritativeFailedStep,
  type ControlPlanCandidatesResponse,
  type CurrentPlanCandidate,
  type ControlRequirementVersion,
  type OrchestrationModeV1,
  type TaskFollowUpMessageV1,
  type TaskFollowUpResponse,
} from '../packages/api-contract/control-workflow.ts';
import {
  isNativeSkillExecutionPlanV1,
  parseNativeSkillExecutionPlanV1,
  type ReadableExecutionPlan,
} from '../packages/api-contract/native-skill-orchestration.ts';
import type { PendingInput } from '../packages/api-contract/research-deliverable.ts';
import {
  isCandidateProfile,
  type CandidateProfile,
  type ResearchTaskV2,
} from '../packages/api-contract/plan.ts';
import type {
  ZeroPublicationFailure,
  ZeroPublicationStage,
  ZeroPublicationStatus,
} from '../packages/api-contract/zero-publication.ts';
import { validateCurrentPlanRevision } from '../apps/orchestrator-runtime/src/planners/plan-compiler.ts';
export type { ControlRequirementVersion };

export type ControlTaskState =
  | 'awaiting_clarification'
  | 'awaiting_selection'
  | 'awaiting_confirmation'
  | 'awaiting_approval'
  | 'ready'
  | 'executing'
  | 'paused'
  | 'reviewing'
  | 'composing_report'
  | 'completed'
  | 'completed_with_gaps'
  | 'failed'
  | 'cancelled'
  | 'rejected';

export type ControlArtifactState = 'STAGING' | 'SEALED' | 'FAILED';
export const ARTIFACT_QUARANTINE_PENDING_MARKER = '; source file was absent at ';
export const ARTIFACT_INVALIDATION_PROMOTION_VERSION = 'artifact-invalidation-promotion-v1';
const ARTIFACT_INVALIDATION_CLEAR_RECEIPT_VERSION = 'artifact-invalidation-clear-receipt-v1';

export interface ControlTask {
  id: string;
  state: ControlTaskState;
  stateVersion: number;
  activePlanVersionId: string | null;
  currentAttemptId: string | null;
}

export interface ControlPlanVersion {
  id: string;
  taskId: string;
  version: number;
  planHash: string;
}

export interface ControlExecutionClaim {
  attemptId: string;
  stateVersion: number;
  replayed: boolean;
}

export interface ControlExecutionLease {
  taskId: string;
  planVersionId: string;
  attemptId: string;
  leaseOwner: string;
  leaseToken: string;
  retryOf?: string | null;
}

export interface ActiveExecutionLease {
  taskId: string;
  planVersionId: string;
  attemptId: string;
  leaseOwner: string;
  leaseExpiresAt: Date;
  stateVersion: number;
}

export interface ControlExecutionStep {
  stepNo: number;
  stepName: string;
  actorType: string;
  actorId: string;
  state: string;
  outputArtifactId: string | null;
  toolProvenance: Record<string, unknown> | null;
  skillProvenance: Record<string, unknown> | null;
  failure: Record<string, unknown> | null;
  latencyMs: number | null;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface ControlModelCall {
  id: string;
  stage: string;
  stepNo: number | null;
  provider: string;
  endpointHost: string;
  requestedModel: string;
  actualModel: string;
  modelVersion: string;
  promptHash: string;
  contextManifestHash: string | null;
  traceId: string | null;
  tokens: Record<string, unknown> | null;
  status: string;
  failure: Record<string, unknown> | null;
}

export interface ControlArtifact {
  id: string;
  taskId: string;
  planVersionId: string | null;
  attemptId: string | null;
  kind: string;
  state: ControlArtifactState;
  storageUri: string;
  contentSha256: string | null;
  byteSize: number | null;
  schemaVersion: string;
  sensitivity: string;
  redactionPolicyVersion: string;
  failureReason: string | null;
  publicationId?: string | null;
  mediaType?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface ControlZeroPublication {
  id: string;
  taskId: string;
  ownerUserId: string;
  planVersionId: string;
  attemptId: string;
  reportPackageArtifactId: string;
  reportPackageHash: string;
  idempotencyKey: string;
  requestHash: string;
  templateVersion: string;
  status: ZeroPublicationStatus;
  stage: ZeroPublicationStage;
  progress: number;
  zeroFileKey: string | null;
  zeroPageId: string;
  zeroPageName: string;
  draftRootNodeId: string | null;
  finalRootNodeId: string | null;
  updatePublicationId: string | null;
  updateRootNodeId: string | null;
  zeroNodeMap: Record<string, unknown> | null;
  imageManifest: unknown[] | null;
  screenshotManifest: unknown[] | null;
  receiptArtifactId: string | null;
  failure: ZeroPublicationFailure | null;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

export class ControlPlaneConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ControlPlaneConflictError';
  }
}

export class ControlPlaneAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskWorkflowAuthorizationError';
  }
}

export class ArtifactNotSealedError extends Error {
  constructor(artifactId: string) {
    super(`artifact ${artifactId} is not sealed`);
    this.name = 'ArtifactNotSealedError';
  }
}

interface CommandResponse {
  attemptId: string;
  stateVersion: number;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`control-plane query missing ${field}`);
  return value;
}

function asNumber(value: unknown, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`control-plane query missing ${field}`);
  return parsed;
}

function asDate(value: unknown, field: string): Date {
  const parsed = value instanceof Date ? value : new Date(asString(value, field));
  if (Number.isNaN(parsed.getTime())) throw new Error(`control-plane query missing ${field}`);
  return parsed;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function strippedExecutionFailure(value: unknown): Record<string, unknown> | null {
  const failure = asRecord(value);
  if (
    !failure
    || (
      !Object.hasOwn(failure, 'artifactInvalidationPromotion')
      && !Object.hasOwn(failure, 'artifactInvalidationClearReceipt')
    )
  ) return failure;
  const publicFailure = { ...failure };
  delete publicFailure.artifactInvalidationPromotion;
  delete publicFailure.artifactInvalidationClearReceipt;
  return publicFailure;
}

function artifactInvalidationPromotionArtifactIds(value: unknown): string[] | null {
  const failure = asRecord(value);
  const marker = asRecord(failure?.artifactInvalidationPromotion);
  const artifactIds = marker?.eligibleArtifactIds;
  if (
    marker?.version !== ARTIFACT_INVALIDATION_PROMOTION_VERSION
    || !Array.isArray(artifactIds)
    || artifactIds.length === 0
    || artifactIds.some((artifactId) => typeof artifactId !== 'string')
    || new Set(artifactIds).size !== artifactIds.length
  ) return null;
  return artifactIds as string[];
}

function publicExecutionFailure(value: unknown): Record<string, unknown> | null {
  const failure = strippedExecutionFailure(value);
  if (!failure || artifactInvalidationPromotionArtifactIds(value) === null) return failure;
  return {
    ...failure,
    kind: 'artifact_invalidation',
    retryable: false,
    allowedActions: ['abort'],
  };
}

function publicExecutionStepFailure(row: Record<string, unknown>): Record<string, unknown> | null {
  const failure = publicExecutionFailure(row.failure_json);
  const skillProvenance = asRecord(row.skill_provenance);
  const legacySkillOutputSchemaFailure = failure?.kind === 'schema'
    && row.actor_type === 'skill'
    && skillProvenance?.status === 'failed'
    && typeof skillProvenance.modelReceiptId === 'string'
    && typeof skillProvenance.outputHash === 'string';
  if (!legacySkillOutputSchemaFailure) return failure;
  return {
    ...failure,
    retryable: true,
    allowedActions: ['retry', 'abort'],
  };
}

function hashLeaseToken(token: string): string {
  return `sha256:${createHash('sha256').update(token).digest('hex')}`;
}


function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  const record = asRecord(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.entries(record)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => [key, stableValue(child)]),
  );
}

function sameStoredValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function serializedGateValue(value: unknown): string | null {
  const serialized = value === undefined ? null : JSON.stringify(value);
  if (serialized && /data:image\/[a-z0-9.+-]+;base64,/iu.test(serialized)) {
    throw new Error('inline image data is forbidden in control gate values');
  }
  return serialized;
}

function isFinalizedRequirement(value: unknown): boolean {
  const requirement = asRecord(value);
  if (!requirement) return false;
  return Array.isArray(requirement.ambiguities)
    && requirement.ambiguities.length === 0
    && Array.isArray(requirement.blocking_issues)
    && requirement.blocking_issues.length === 0
    && Array.isArray(requirement.clarification_questions)
    && requirement.clarification_questions.length === 0;
}

function canonicalPlan(plan: unknown): { json: string; hash: string } {
  const json = JSON.stringify(stableValue(plan));
  if (json === undefined) throw new ControlPlaneConflictError('plan is not JSON serializable');
  return {
    json,
    hash: `sha256:${createHash('sha256').update(json).digest('hex')}`,
  };
}

export function canonicalPlanHash(plan: unknown): string {
  return canonicalPlan(plan).hash;
}


async function validateProblemGraphReceipt(
  connection: MigrationConnection,
  plan: unknown,
): Promise<void> {
  const record = asRecord(plan);
  const provenance = record ? asRecord(record.problem_graph_provenance) : null;
  const receiptId = provenance?.receiptId;
  if (!provenance || typeof receiptId !== 'string') {
    throw new ControlPlaneConflictError('problem graph provenance receiptId is missing');
  }
  const result = await connection.query(
    `SELECT stage, attempt_id, status, actual_model, model_version, prompt_hash, trace_id
     FROM control_model_calls
     WHERE id = $1
     FOR SHARE`,
    [receiptId],
  );
  const receipt = result.rows[0];
  if (
    !receipt
    || receipt.attempt_id !== null
    || receipt.stage !== 'problem_graph'
    || receipt.status !== 'succeeded'
    || receipt.actual_model !== provenance.modelName
    || receipt.model_version !== provenance.modelVersion
    || receipt.prompt_hash !== provenance.promptHash
    || receipt.trace_id !== provenance.traceId
  ) {
    throw new ControlPlaneConflictError(`problem graph provenance receipt ${receiptId} is not bound to the persisted model call`);
  }
}
function planForTask(plan: unknown, taskId: string): { json: string; hash: string } {
  const record = asRecord(plan);
  if (!record) throw new ControlPlaneConflictError('candidate plan must be an object');
  return canonicalPlan({ ...record, task_id: taskId });
}

function candidateMetadata(plan: Record<string, unknown>): {
  title: string;
  rationale: string;
  tradeoffs: string;
} {
  const metadata = asRecord(plan.candidate_metadata);
  const title = metadata && typeof metadata.title === 'string' ? metadata.title.trim() : '';
  const rationale = metadata && typeof metadata.rationale === 'string' ? metadata.rationale.trim() : '';
  const tradeoffs = metadata && typeof metadata.tradeoffs === 'string' ? metadata.tradeoffs.trim() : '';
  if (!title || !rationale || !tradeoffs) {
    throw new ControlPlaneConflictError('candidate plan metadata is missing or malformed');
  }
  return { title, rationale, tradeoffs };
}

function candidateActivatedNodes(plan: Record<string, unknown>): string[] {
  const activatedNodes = plan.activated_nodes;
  if (!Array.isArray(activatedNodes) || activatedNodes.some((node) => typeof node !== 'string')) {
    throw new ControlPlaneConflictError('candidate plan activated_nodes is malformed');
  }
  return activatedNodes;
}

function candidateRecommended(plan: Record<string, unknown>): boolean | undefined {
  const metadata = asRecord(plan.candidate_metadata);
  if (!metadata) {
    throw new ControlPlaneConflictError('candidate plan metadata is missing or malformed');
  }
  if (!Object.hasOwn(metadata, 'recommended')) return undefined;
  if (typeof metadata.recommended !== 'boolean') {
    throw new ControlPlaneConflictError('candidate plan recommendation is malformed');
  }
  return metadata.recommended;
}

function assertCompatibleCandidateSet(
  candidates: readonly { candidateId: unknown; plan: unknown }[],
  context: string,
): void {
  const candidateIds = candidates.map(({ candidateId }) => candidateId);
  if (
    candidates.length < 2
    || candidates.length > 4
    || candidateIds.some((candidateId) => !isCandidateProfile(candidateId))
    || new Set(candidateIds).size !== candidateIds.length
    || !candidateIds.includes('speed')
    || !candidateIds.includes('depth')
    || (
      candidateIds.length > 2
      && (candidateIds[0] !== 'speed' || candidateIds[1] !== 'depth')
    )
  ) {
    throw new ControlPlaneConflictError(
      `${context} requires 2-4 unique controlled candidates in baseline-first order`,
    );
  }
  const recommendedCount = candidates.filter(({ plan }) => {
    const planRecord = asRecord(plan);
    if (!planRecord) throw new ControlPlaneConflictError('candidate plan must be an object');
    candidateMetadata(planRecord);
    return candidateRecommended(planRecord) === true;
  }).length;
  if (recommendedCount > 1) {
    throw new ControlPlaneConflictError(`${context} has multiple recommended candidates`);
  }
}

function currentPlanCandidateFromRow(
  row: Record<string, unknown>,
  taskId: string,
): CurrentPlanCandidate {
  const plan = asRecord(row.plan_json);
  if (!plan || plan.task_id !== taskId) {
    throw new ControlPlaneConflictError('candidate plan task binding is malformed');
  }
  const planHash = asString(row.plan_hash, 'plan_hash');
  if (canonicalPlanHash(plan) !== planHash) {
    throw new ControlPlaneConflictError('candidate plan canonical hash does not match stored hash');
  }
  const candidateId = asString(row.candidate_id, 'candidate_id');
  if (!isCandidateProfile(candidateId)) {
    throw new ControlPlaneConflictError('candidate plan identity is malformed');
  }
  if (!Array.isArray(row.pending_inputs)) {
    throw new ControlPlaneConflictError('candidate pending inputs are malformed');
  }
  candidateActivatedNodes(plan);
  candidateRecommended(plan);
  const executionPlan = plan as unknown as ReadableExecutionPlan;
  return {
    planVersionId: asString(row.id, 'id'),
    candidateId,
    ...candidateMetadata(plan),
    planHash,
    plan: executionPlan,
    pendingInputs: row.pending_inputs as PendingInput[],
    ...(isNativeSkillExecutionPlanV1(executionPlan)
      ? { resolvedInputs: parseNativeSkillExecutionPlanV1(executionPlan).resolved_inputs }
      : {}),
  };
}

function latestCandidateSet(
  rows: Array<Record<string, unknown>>,
): Record<string, unknown>[] {
  const newestGeneration: Record<string, unknown>[] = [];
  const candidateIds = new Set<CandidateProfile>();
  for (const row of rows) {
    const candidateId = asString(row.candidate_id, 'candidate_id');
    if (!isCandidateProfile(candidateId)) {
      throw new ControlPlaneConflictError('candidate plan identity is malformed');
    }
    if (candidateIds.has(candidateId)) break;
    candidateIds.add(candidateId);
    newestGeneration.push(row);
    if (candidateIds.has('speed') && candidateIds.has('depth')) break;
    if (newestGeneration.length === 4) break;
  }
  const byVersion = newestGeneration.sort(
    (left, right) => asNumber(left.version, 'version') - asNumber(right.version, 'version'),
  );
  assertCompatibleCandidateSet(
    byVersion.map((row) => ({ candidateId: row.candidate_id, plan: row.plan_json })),
    'awaiting_selection task',
  );
  const firstVersion = asNumber(byVersion[0]?.version, 'version');
  if (byVersion.some((row, index) => asNumber(row.version, 'version') !== firstVersion + index)) {
    throw new ControlPlaneConflictError(
      'awaiting_selection task requires consecutive candidate plan versions',
    );
  }
  return byVersion;
}

export interface SelectionResponse {
  planVersionId: string;
  state: ControlTaskState;
  stateVersion: number;
}

function selectionResponse(value: unknown): SelectionResponse {
  const response = asRecord(value);
  if (!response) throw new Error('control-plane selection response is invalid');
  return {
    planVersionId: asString(response.planVersionId, 'planVersionId'),
    state: asString(response.state, 'state') as ControlTaskState,
    stateVersion: asNumber(response.stateVersion, 'stateVersion'),
  };
}

function commandResponse(value: unknown): CommandResponse {
  if (!value || typeof value !== 'object') throw new Error('control-plane command response is invalid');
  const response = value as Record<string, unknown>;
  return {
    attemptId: asString(response.attemptId, 'attemptId'),
    stateVersion: asNumber(response.stateVersion, 'stateVersion'),
  };
}

function artifactFromRow(row: Record<string, unknown>): ControlArtifact {
  return {
    id: asString(row.id, 'id'),
    taskId: asString(row.task_id, 'task_id'),
    planVersionId: typeof row.plan_version_id === 'string' ? row.plan_version_id : null,
    attemptId: typeof row.attempt_id === 'string' ? row.attempt_id : null,
    kind: asString(row.kind, 'kind'),
    state: asString(row.state, 'state') as ControlArtifactState,
    storageUri: asString(row.storage_uri, 'storage_uri'),
    contentSha256: typeof row.content_sha256 === 'string' ? row.content_sha256 : null,
    byteSize: row.byte_size == null ? null : asNumber(row.byte_size, 'byte_size'),
    schemaVersion: asString(row.schema_version, 'schema_version'),
    sensitivity: asString(row.sensitivity, 'sensitivity'),
    redactionPolicyVersion: asString(row.redaction_policy_version, 'redaction_policy_version'),
    failureReason: typeof row.failure_reason === 'string' ? row.failure_reason : null,
    publicationId: typeof row.publication_id === 'string' ? row.publication_id : null,
    mediaType: typeof row.media_type === 'string' ? row.media_type : null,
    metadata: asRecord(row.metadata_json),
  };
}

function modelCallFromRow(row: Record<string, unknown>): ControlModelCall {
  return {
    id: asString(row.id, 'id'),
    stage: asString(row.stage, 'stage'),
    stepNo: row.step_no == null ? null : asNumber(row.step_no, 'step_no'),
    provider: asString(row.provider, 'provider'),
    endpointHost: asString(row.endpoint_host, 'endpoint_host'),
    requestedModel: asString(row.requested_model, 'requested_model'),
    actualModel: asString(row.actual_model, 'actual_model'),
    modelVersion: asString(row.model_version, 'model_version'),
    promptHash: asString(row.prompt_hash, 'prompt_hash'),
    contextManifestHash: typeof row.context_manifest_hash === 'string' ? row.context_manifest_hash : null,
    traceId: typeof row.trace_id === 'string' ? row.trace_id : null,
    tokens: asRecord(row.tokens_json),
    status: asString(row.status, 'status'),
    failure: asRecord(row.failure_json),
  };
}

function zeroPublicationFromRow(row: Record<string, unknown>): ControlZeroPublication {
  const failure = row.failure_json == null ? null : asRecord(row.failure_json);
  if (
    failure
    && (
      typeof failure.code !== 'string'
      || typeof failure.message !== 'string'
      || typeof failure.retryable !== 'boolean'
    )
  ) {
    throw new Error('control-plane query has malformed Zero publication failure');
  }
  const imageManifest = row.image_manifest == null ? null : row.image_manifest;
  const screenshotManifest = row.screenshot_manifest == null ? null : row.screenshot_manifest;
  if (imageManifest !== null && !Array.isArray(imageManifest)) {
    throw new Error('control-plane query has malformed Zero image manifest');
  }
  if (screenshotManifest !== null && !Array.isArray(screenshotManifest)) {
    throw new Error('control-plane query has malformed Zero screenshot manifest');
  }
  return {
    id: asString(row.id, 'id'),
    taskId: asString(row.task_id, 'task_id'),
    ownerUserId: asString(row.owner_user_id, 'owner_user_id'),
    planVersionId: asString(row.plan_version_id, 'plan_version_id'),
    attemptId: asString(row.attempt_id, 'attempt_id'),
    reportPackageArtifactId: asString(row.report_package_artifact_id, 'report_package_artifact_id'),
    reportPackageHash: asString(row.report_package_hash, 'report_package_hash'),
    idempotencyKey: asString(row.idempotency_key, 'idempotency_key'),
    requestHash: asString(row.request_hash, 'request_hash'),
    templateVersion: asString(row.template_version, 'template_version'),
    status: asString(row.status, 'status') as ZeroPublicationStatus,
    stage: asString(row.stage, 'stage') as ZeroPublicationStage,
    progress: asNumber(row.progress, 'progress'),
    zeroFileKey: typeof row.zero_file_key === 'string' ? row.zero_file_key : null,
    zeroPageId: asString(row.zero_page_id, 'zero_page_id'),
    zeroPageName: asString(row.zero_page_name, 'zero_page_name'),
    draftRootNodeId: typeof row.draft_root_node_id === 'string' ? row.draft_root_node_id : null,
    finalRootNodeId: typeof row.final_root_node_id === 'string' ? row.final_root_node_id : null,
    updatePublicationId: typeof row.update_publication_id === 'string' ? row.update_publication_id : null,
    updateRootNodeId: typeof row.update_root_node_id === 'string' ? row.update_root_node_id : null,
    zeroNodeMap: asRecord(row.zero_node_map),
    imageManifest: imageManifest as unknown[] | null,
    screenshotManifest: screenshotManifest as unknown[] | null,
    receiptArtifactId: typeof row.receipt_artifact_id === 'string' ? row.receipt_artifact_id : null,
    failure: failure as ZeroPublicationFailure | null,
    leaseOwner: typeof row.lease_owner === 'string' ? row.lease_owner : null,
    leaseExpiresAt: row.lease_expires_at == null ? null : asDate(row.lease_expires_at, 'lease_expires_at'),
    createdAt: asDate(row.created_at, 'created_at'),
    updatedAt: asDate(row.updated_at, 'updated_at'),
    completedAt: row.completed_at == null ? null : asDate(row.completed_at, 'completed_at'),
  };
}

export interface ControlTaskDetail extends ControlTask {
  conversationId: string;
  originalInput: string;
  ownerUserId: string;
  conversationOwnerUserId: string;
  structuredTask: unknown;
  activeRequirementVersionId: string | null;
  orchestrationMode?: OrchestrationModeV1 | null;
}
export interface ControlTaskSummary {
  id: string;
  originalInput: string;
  taskType: string | null;
  state: ControlTaskState;
  createdAt: Date;
  updatedAt: Date;
}
export interface PersistedIndependentReview {
  reviewerId: string;
  authenticated: boolean;
  independent: boolean;
  verdict: string;
}


function requirementVersionFromRow(row: Record<string, unknown>): ControlRequirementVersion {
  return {
    id: asString(row.id, 'id'),
    taskId: asString(row.task_id, 'task_id'),
    version: asNumber(row.version, 'version'),
    rawInputHash: asString(row.raw_input_hash, 'raw_input_hash'),
    clarification: row.clarification_json,
    structuredTask: row.structured_task_json as ControlRequirementVersion['structuredTask'],
    modelCallId: typeof row.model_call_id === 'string' ? row.model_call_id : null,
    createdAt: asDate(row.created_at, 'created_at'),
  };
}

function controlTaskDetailFromRow(row: Record<string, unknown>): ControlTaskDetail {
  return {
    id: asString(row.id, 'id'),
    conversationId: asString(row.conversation_id, 'conversation_id'),
    originalInput: asString(row.original_input, 'original_input'),
    ownerUserId: asString(row.owner_user_id, 'owner_user_id'),
    conversationOwnerUserId: asString(row.conversation_owner_user_id, 'conversation_owner_user_id'),
    structuredTask: row.structured_task,
    state: asString(row.state, 'state') as ControlTaskState,
    stateVersion: asNumber(row.state_version, 'state_version'),
    activePlanVersionId: typeof row.active_plan_version_id === 'string' ? row.active_plan_version_id : null,
    currentAttemptId: typeof row.current_attempt_id === 'string' ? row.current_attempt_id : null,
    activeRequirementVersionId: typeof row.active_requirement_version_id === 'string' ? row.active_requirement_version_id : null,
    orchestrationMode: row.orchestration_mode === 'single_skill' || row.orchestration_mode === 'multi_skill'
      ? row.orchestration_mode
      : null,
  };
}

function controlTaskSummaryFromRow(row: Record<string, unknown>): ControlTaskSummary {
  return {
    id: asString(row.id, 'id'),
    originalInput: asString(row.original_input, 'original_input'),
    taskType: typeof row.task_type === 'string' ? row.task_type : null,
    state: asString(row.state, 'state') as ControlTaskState,
    createdAt: asDate(row.created_at, 'created_at'),
    updatedAt: asDate(row.updated_at, 'updated_at'),
  };
}

function taskFollowUpMessageFromRow(row: Record<string, unknown>): TaskFollowUpMessageV1 {
  const content = asRecord(row.content);
  const role = asString(row.sender_type, 'sender_type');
  const sourceIds = content?.sourceIds;
  const gaps = content?.gaps;
  if (
    content?.version !== 'task-follow-up-message-v1'
    || (role !== 'user' && role !== 'assistant')
    || content.role !== role
    || content.id !== row.id
    || typeof content.taskId !== 'string'
    || typeof content.content !== 'string'
    || !Array.isArray(sourceIds)
    || sourceIds.some((value) => typeof value !== 'string')
    || !Array.isArray(gaps)
    || gaps.some((value) => typeof value !== 'string')
  ) {
    throw new Error('task follow-up message is malformed');
  }
  return {
    version: 'task-follow-up-message-v1',
    id: asString(row.id, 'id'),
    taskId: content.taskId,
    role,
    content: content.content,
    sourceIds: sourceIds as string[],
    gaps: gaps as string[],
    createdAt: asDate(row.created_at, 'created_at').toISOString(),
  };
}

export interface ControlPlanVersionDetail extends ControlPlanVersion {
  candidateId: string | null;
  plan: unknown;
  pendingInputs: unknown;
}

export type ControlCandidateId = CandidateProfile;

export interface ControlCandidatePlanVersionDetail
  extends Omit<ControlPlanVersionDetail, 'candidateId' | 'plan' | 'pendingInputs'> {
  candidateId: ControlCandidateId;
  plan: ReadableExecutionPlan;
  pendingInputs: PendingInput[];
}

export interface ControlGateRecord {
  gateType: string;
  gateKey: string;
  requiredAuthority: string;
  decision: string;
  value: unknown;
  evidenceRef: string | null;
  actorUserId: string | null;
  actorRole: string | null;
  idempotencyKey: string;
}

export interface ControlCommandRecord {
  requestHash: string;
  response: unknown;
}

export type ControlCommandReservation =
  | { status: 'reserved'; reservationToken: string }
  | { status: 'pending' }
  | { status: 'replay'; response: unknown }
  | { status: 'conflict' };

export type ControlCommandWaitResult =
  | { status: 'replay'; response: unknown }
  | { status: 'released' | 'timeout' | 'conflict' };

export interface PersistClarificationCandidatesInput {
  taskId: string;
  conversationId: string;
  ownerUserId: string;
  expectedStateVersion: number;
  taskType: string;
  structuredTask: ResearchTaskV2;
  orchestrationMode: OrchestrationModeV1;
  activatedNodes: string[];
  clarificationRecovery?: {
    mode: 'latest_finalized_requirement';
    activeRequirementVersionId: string;
  };
  candidates: Array<{
    candidateId: ControlCandidateId;
    title: string;
    rationale: string;
    tradeoffs: string;
    plan: Omit<ReadableExecutionPlan, 'task_id'> & { task_id?: string };
    pendingInputs: PendingInput[];
  }>;
  command: {
    commandType: 'clarification';
    idempotencyKey: string;
    requestHash: string;
    expectedVersion: number;
    reservationToken: string;
    actorUserId: string;
  };
}

export class ControlPlaneRepository {
  constructor(private readonly database: MigrationDatabase) {}

  private async transaction<T>(work: (connection: MigrationConnection) => Promise<T>): Promise<T> {
    const connection = await this.database.connect();
    let transactionOpen = false;
    try {
      await connection.query('BEGIN');
      transactionOpen = true;
      const result = await work(connection);
      await connection.query('COMMIT');
      transactionOpen = false;
      return result;
    } catch (error) {
      if (transactionOpen) await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }
  private async pauseExpiredExecutionLease(
    connection: MigrationConnection,
    input: {
      taskId: string;
      attemptId: string;
      planVersionId?: string;
      leaseOwner?: string;
      leaseToken?: string;
    },
  ): Promise<ControlTask | null> {
    const leaseTokenHash = input.leaseToken === undefined ? null : hashLeaseToken(input.leaseToken);
    const lockedTask = await connection.query(
      `SELECT state, current_attempt_id, active_plan_version_id
       FROM control_tasks
       WHERE id = $1
       FOR UPDATE`,
      [input.taskId],
    );
    const taskRow = lockedTask.rows[0];
    const taskState = taskRow ? asString(taskRow.state, 'state') : null;
    if (
      !taskRow
      || !taskState
      || !['executing', 'reviewing', 'composing_report'].includes(taskState)
      || taskRow.current_attempt_id !== input.attemptId
    ) return null;
    const locked = await connection.query(
      `SELECT plan_version_id
       FROM control_execution_attempts
       WHERE id = $1
         AND task_id = $2
         AND ($3::uuid IS NULL OR plan_version_id = $3::uuid)
         AND ($4::text IS NULL OR lease_owner = $4)
         AND ($5::text IS NULL OR lease_token_hash = $5)
         AND state = 'active'
         AND lease_expires_at <= now()
       FOR UPDATE`,
      [input.attemptId, input.taskId, input.planVersionId ?? null, input.leaseOwner ?? null, leaseTokenHash],
    );
    const lockedRow = locked.rows[0];
    if (!lockedRow) return null;
    const planVersionId = asString(lockedRow.plan_version_id, 'plan_version_id');
    if (taskRow.active_plan_version_id !== planVersionId) return null;

    const attempt = await connection.query(
      `UPDATE control_execution_attempts
       SET state = 'paused',
           failure_kind = CASE
             WHEN EXISTS (
               SELECT 1
               FROM control_execution_steps
               WHERE attempt_id = $1
                 AND state = 'failed'
                 AND failure_json->>'kind' = 'artifact_invalidation'
             ) THEN 'artifact_invalidation'
             ELSE 'worker_loss'
           END,
           finished_at = now()
       WHERE id = $1
         AND task_id = $2
         AND plan_version_id = $3
         AND ($4::text IS NULL OR lease_owner = $4)
         AND ($5::text IS NULL OR lease_token_hash = $5)
         AND state = 'active'
         AND lease_expires_at <= now()
       RETURNING id`,
      [input.attemptId, input.taskId, planVersionId, input.leaseOwner ?? null, leaseTokenHash],
    );
    if (!attempt.rows[0]) {
      throw new ControlPlaneConflictError(`execution lease ${input.attemptId} changed during expiry recovery`);
    }
    await connection.query(
      `UPDATE control_execution_steps
       SET state = 'failed',
           failure_json = COALESCE(failure_json, $2::jsonb),
           started_at = COALESCE(started_at, now()),
           finished_at = COALESCE(finished_at, now())
       WHERE attempt_id = $1
         AND state IN ('pending', 'running')`,
      [
        input.attemptId,
        JSON.stringify({
          kind: 'worker_loss',
          retryable: true,
          allowedActions: ['retry', 'abort'],
        }),
      ],
    );

    const task = await connection.query(
      `UPDATE control_tasks
       SET state = 'paused', state_version = state_version + 1, updated_at = now()
       WHERE id = $1
         AND state IN ('executing', 'reviewing', 'composing_report')
         AND current_attempt_id = $2
         AND active_plan_version_id = $3
       RETURNING id, state, state_version, active_plan_version_id, current_attempt_id`,
      [input.taskId, input.attemptId, planVersionId],
    );
    const row = task.rows[0];
    if (!row) throw new ControlPlaneConflictError(`task ${input.taskId} changed during expiry recovery`);
    return {
      id: asString(row.id, 'id'),
      state: asString(row.state, 'state') as ControlTaskState,
      stateVersion: asNumber(row.state_version, 'state_version'),
      activePlanVersionId: typeof row.active_plan_version_id === 'string' ? row.active_plan_version_id : null,
      currentAttemptId: typeof row.current_attempt_id === 'string' ? row.current_attempt_id : null,
    };
  }

  async createTask(input: {
    conversationId: string;
    ownerUserId: string;
    originalInput: string;
    taskType: string | null;
    structuredTask: unknown;
    state: ControlTaskState;
    sensitivity?: string;
    piiDetected?: boolean;
    orchestrationMode?: OrchestrationModeV1;
  }): Promise<ControlTask> {
    return this.transaction(async (connection) => {
      const result = await connection.query(
        `INSERT INTO control_tasks
           (conversation_id, owner_user_id, original_input, task_type, structured_task, state, sensitivity, pii_detected, orchestration_mode)
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 'internal'), COALESCE($8, false), $9)
         RETURNING id, state, state_version, active_plan_version_id, current_attempt_id`,
        [
          input.conversationId,
          input.ownerUserId,
          input.originalInput,
          input.taskType,
          JSON.stringify(input.structuredTask),
          input.state,
          input.sensitivity ?? null,
          input.piiDetected ?? null,
          input.orchestrationMode ?? null,
        ],
      );
      const row = result.rows[0] ?? {};
      return {
        id: asString(row.id, 'id'),
        state: asString(row.state, 'state') as ControlTaskState,
        stateVersion: asNumber(row.state_version, 'state_version'),
        activePlanVersionId: typeof row.active_plan_version_id === 'string' ? row.active_plan_version_id : null,
        currentAttemptId: typeof row.current_attempt_id === 'string' ? row.current_attempt_id : null,
      };
    });
  }

  async createRequirementVersion(input: {
    taskId: string;
    version: number;
    rawInputHash: string;
    clarification: unknown;
    structuredTask: unknown;
    modelCallId?: string | null;
  }): Promise<ControlRequirementVersion> {
    return this.transaction(async (connection) => {
      const task = await connection.query(
        `SELECT id, state FROM control_tasks WHERE id = $1 FOR KEY SHARE`,
        [input.taskId],
      );
      if (!task.rows[0]) throw new ControlPlaneConflictError(`task ${input.taskId} does not exist`);
      if (task.rows[0].state !== 'awaiting_clarification') throw new ControlPlaneConflictError(`task ${input.taskId} is not awaiting_clarification`);
      const result = await connection.query(
        `INSERT INTO control_requirement_versions
           (task_id, version, raw_input_hash, clarification_json, structured_task_json, model_call_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, task_id, version, raw_input_hash, clarification_json,
                   structured_task_json, model_call_id, created_at`,
        [
          input.taskId,
          input.version,
          input.rawInputHash,
          JSON.stringify(input.clarification),
          JSON.stringify(input.structuredTask),
          input.modelCallId ?? null,
        ],
      );
      return requirementVersionFromRow(result.rows[0] ?? {});
    });
  }

  async createAndActivateRequirementVersion(input: {
    taskId: string;
    ownerUserId: string;
    expectedVersion: number;
    rawInputHash: string;
    clarification: unknown;
    structuredTask: unknown;
    modelCallId?: string | null;
  }): Promise<{ version: ControlRequirementVersion; task: ControlTaskDetail }> {
    return this.transaction(async (connection) => {
      const taskResult = await connection.query(
        `SELECT task.id, task.conversation_id, task.original_input, task.owner_user_id,
                conversation.owner_user_id AS conversation_owner_user_id,
                task.structured_task, task.state, task.state_version,
                task.active_plan_version_id, task.current_attempt_id,
                task.active_requirement_version_id, task.orchestration_mode
         FROM control_tasks AS task
         JOIN conversations AS conversation ON conversation.id = task.conversation_id
         WHERE task.id = $1
         FOR UPDATE OF task`,
        [input.taskId],
      );
      const task = taskResult.rows[0];
      if (!task) throw new ControlPlaneConflictError(`task ${input.taskId} does not exist`);
      if (
        task.owner_user_id !== input.ownerUserId
        || task.conversation_owner_user_id !== input.ownerUserId
      ) {
        throw new ControlPlaneAuthorizationError(`actor cannot control task ${input.taskId}`);
      }
      if (task.state !== 'awaiting_clarification') throw new ControlPlaneConflictError(`task ${input.taskId} is not awaiting_clarification`);
      if (asNumber(task.state_version, 'state_version') !== input.expectedVersion) {
        throw new ControlPlaneConflictError(`task ${input.taskId} is not at version ${input.expectedVersion}`);
      }

      const versionResult = await connection.query(
        `INSERT INTO control_requirement_versions
           (task_id, version, raw_input_hash, clarification_json, structured_task_json, model_call_id)
         SELECT $1, COALESCE(MAX(version), 0) + 1, $2, $3, $4, $5
         FROM control_requirement_versions
         WHERE task_id = $1
         RETURNING id, task_id, version, raw_input_hash, clarification_json,
                   structured_task_json, model_call_id, created_at`,
        [
          input.taskId,
          input.rawInputHash,
          JSON.stringify(input.clarification),
          JSON.stringify(input.structuredTask),
          input.modelCallId ?? null,
        ],
      );
      const versionRow = versionResult.rows[0] ?? {};
      const updated = await connection.query(
        `UPDATE control_tasks
         SET active_requirement_version_id = $2,
             structured_task = $3,
             state_version = state_version + 1,
             updated_at = now()
         WHERE id = $1
           AND state = 'awaiting_clarification'
           AND state_version = $4
         RETURNING id, conversation_id, original_input, owner_user_id,
                   (SELECT owner_user_id FROM conversations WHERE id = control_tasks.conversation_id)
                     AS conversation_owner_user_id,
                   structured_task, state, state_version, active_plan_version_id,
                   current_attempt_id, active_requirement_version_id, orchestration_mode`,
        [input.taskId, versionRow.id, JSON.stringify(input.structuredTask), input.expectedVersion],
      );
      const row = updated.rows[0];
      if (!row) throw new ControlPlaneConflictError(`task ${input.taskId} lost requirement activation CAS`);
      return {
        version: requirementVersionFromRow(versionRow),
        task: controlTaskDetailFromRow(row),
      };
    });
  }

  async getActiveRequirementVersion(taskId: string): Promise<ControlRequirementVersion | null> {
    return this.transaction(async (connection) => {
      const result = await connection.query(
        `SELECT requirement.id, requirement.task_id, requirement.version,
                requirement.raw_input_hash, requirement.clarification_json,
                requirement.structured_task_json, requirement.model_call_id,
                requirement.created_at
         FROM control_requirement_versions AS requirement
         JOIN control_tasks AS task
           ON task.active_requirement_version_id = requirement.id
          AND task.id = requirement.task_id
         WHERE task.id = $1`,
        [taskId],
      );
      const row = result.rows[0];
      return row ? requirementVersionFromRow(row) : null;
    });
  }

  async activateRequirementVersion(input: {
    taskId: string;
    requirementVersionId: string;
    expectedVersion: number;
    ownerUserId: string;
  }): Promise<ControlTaskDetail> {
    return this.transaction(async (connection) => {
      const taskResult = await connection.query(
        `SELECT task.id, task.conversation_id, task.original_input, task.owner_user_id,
                conversation.owner_user_id AS conversation_owner_user_id,
                task.structured_task, task.state, task.state_version,
                task.active_plan_version_id, task.current_attempt_id,
                task.active_requirement_version_id, task.orchestration_mode
         FROM control_tasks AS task
         JOIN conversations AS conversation ON conversation.id = task.conversation_id
         WHERE task.id = $1
         FOR UPDATE OF task`,
        [input.taskId],
      );
      const task = taskResult.rows[0];
      if (!task) throw new ControlPlaneConflictError(`task ${input.taskId} does not exist`);
      if (
        task.owner_user_id !== input.ownerUserId
        || task.conversation_owner_user_id !== input.ownerUserId
      ) {
        throw new ControlPlaneAuthorizationError(`actor cannot control task ${input.taskId}`);
      }
      if (task.state !== 'awaiting_clarification') throw new ControlPlaneConflictError(`task ${input.taskId} is not awaiting_clarification`);
      if (asNumber(task.state_version, 'state_version') !== input.expectedVersion) {
        throw new ControlPlaneConflictError(`task ${input.taskId} is not at version ${input.expectedVersion}`);
      }

      const requirementResult = await connection.query(
        `SELECT id, task_id, version, raw_input_hash, clarification_json,
                structured_task_json, model_call_id, created_at
         FROM control_requirement_versions
         WHERE id = $1
         FOR KEY SHARE`,
        [input.requirementVersionId],
      );
      const requirement = requirementResult.rows[0];
      if (!requirement || requirement.task_id !== input.taskId) {
        throw new ControlPlaneConflictError(
          `requirement version ${input.requirementVersionId} does not belong to task ${input.taskId}`,
        );
      }

      const updated = await connection.query(
        `UPDATE control_tasks
         SET active_requirement_version_id = $2,
             structured_task = (SELECT structured_task_json FROM control_requirement_versions WHERE id = $2),
             state_version = state_version + 1,
             updated_at = now()
         WHERE id = $1 AND state = 'awaiting_clarification' AND state_version = $3
         RETURNING id, conversation_id, original_input, owner_user_id,
                   (SELECT owner_user_id FROM conversations WHERE id = control_tasks.conversation_id)
                     AS conversation_owner_user_id,
                   structured_task, state, state_version,
                   active_plan_version_id, current_attempt_id,
                   active_requirement_version_id, orchestration_mode`,
        [input.taskId, input.requirementVersionId, input.expectedVersion],
      );
      const row = updated.rows[0];
      if (!row) throw new ControlPlaneConflictError(`task ${input.taskId} lost requirement activation CAS`);
      return controlTaskDetailFromRow(row);
    });
  }

  async createTaskWithCandidates(input: {
    conversationId: string;
    ownerUserId: string;
    originalInput: string;
    taskType: string | null;
    structuredTask: unknown;
    orchestrationMode?: OrchestrationModeV1;
    candidates: Array<{
      candidateId: ControlCandidateId;
      plan: Omit<ReadableExecutionPlan, 'task_id'> & { task_id?: string };
      pendingInputs: PendingInput[];
    }>;
  }): Promise<{ task: ControlTask; candidates: ControlCandidatePlanVersionDetail[] }> {
    return this.transaction(async (connection) => {
      const conversationResult = await connection.query(
        `SELECT owner_user_id FROM conversations WHERE id = $1 FOR UPDATE`,
        [input.conversationId],
      );
      const conversation = conversationResult.rows[0];
      if (!conversation || conversation.owner_user_id !== input.ownerUserId) {
        throw new ControlPlaneConflictError(`conversation ${input.conversationId} does not belong to owner ${input.ownerUserId}`);
      }
      assertCompatibleCandidateSet(input.candidates, 'task planning');

      const taskId = randomUUID();
      const taskResult = await connection.query(
        `INSERT INTO control_tasks
           (id, conversation_id, owner_user_id, original_input, task_type, structured_task, state, orchestration_mode)
         VALUES ($1, $2, $3, $4, $5, $6, 'awaiting_selection', $7)
         RETURNING id, state, state_version, active_plan_version_id, current_attempt_id`,
        [
          taskId,
          input.conversationId,
          input.ownerUserId,
          input.originalInput,
          input.taskType,
          JSON.stringify(input.structuredTask),
          input.orchestrationMode ?? null,
        ],
      );
      const taskRow = taskResult.rows[0] ?? {};
      const task: ControlTask = {
        id: asString(taskRow.id, 'id'),
        state: asString(taskRow.state, 'state') as ControlTaskState,
        stateVersion: asNumber(taskRow.state_version, 'state_version'),
        activePlanVersionId: typeof taskRow.active_plan_version_id === 'string' ? taskRow.active_plan_version_id : null,
        currentAttemptId: typeof taskRow.current_attempt_id === 'string' ? taskRow.current_attempt_id : null,
      };

      const preparedCandidates = input.candidates.map((candidate) => ({
        candidate,
        persistedPlan: planForTask(candidate.plan, taskId),
      }));
      for (const { persistedPlan } of preparedCandidates) {
        await validateProblemGraphReceipt(connection, JSON.parse(persistedPlan.json));
      }
      const planHashes = new Set<string>();
      for (const { persistedPlan } of preparedCandidates) {
        if (planHashes.has(persistedPlan.hash)) {
          throw new ControlPlaneConflictError(`candidate plan hash ${persistedPlan.hash} is duplicated`);
        }
        planHashes.add(persistedPlan.hash);
      }
      const candidates: ControlCandidatePlanVersionDetail[] = [];
      for (const [index, { candidate, persistedPlan }] of preparedCandidates.entries()) {
        const planResult = await connection.query(
          `INSERT INTO control_plan_versions
             (task_id, version, candidate_id, plan_json, plan_hash, pending_inputs)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, task_id, version, candidate_id, plan_json, plan_hash, pending_inputs`,
          [
            taskId,
            index + 1,
            candidate.candidateId,
            persistedPlan.json,
            persistedPlan.hash,
            JSON.stringify(candidate.pendingInputs),
          ],
        );
        const planRow = planResult.rows[0] ?? {};
        candidates.push({
          id: asString(planRow.id, 'id'),
          taskId: asString(planRow.task_id, 'task_id'),
          version: asNumber(planRow.version, 'version'),
          candidateId: asString(planRow.candidate_id, 'candidate_id') as ControlCandidateId,
          plan: planRow.plan_json as ReadableExecutionPlan,
          planHash: asString(planRow.plan_hash, 'plan_hash'),
          pendingInputs: planRow.pending_inputs as PendingInput[],
        });
      }
      return { task, candidates };
    });
  }

  async persistExistingTaskWithCandidates(input: {
    taskId: string;
    conversationId: string;
    ownerUserId: string;
    expectedStateVersion: number;
    taskType: string | null;
    structuredTask: unknown;
    candidates: Array<{
      candidateId: ControlCandidateId;
      plan: Omit<ReadableExecutionPlan, 'task_id'> & { task_id?: string };
      pendingInputs: PendingInput[];
    }>;
  }): Promise<{ task: ControlTask; candidates: ControlCandidatePlanVersionDetail[] }> {
    return this.transaction(async (connection) => {
      const taskResult = await connection.query(
        `SELECT task.id, task.conversation_id, task.owner_user_id,
                conversation.owner_user_id AS conversation_owner_user_id,
                task.task_type, task.structured_task, task.state, task.state_version,
                task.active_plan_version_id, task.current_attempt_id
         FROM control_tasks AS task
         JOIN conversations AS conversation ON conversation.id = task.conversation_id
         WHERE task.id = $1
         FOR UPDATE OF task`,
        [input.taskId],
      );
      const taskRow = taskResult.rows[0];
      if (!taskRow) throw new ControlPlaneConflictError(`task ${input.taskId} does not exist`);
      if (taskRow.conversation_id !== input.conversationId) {
        throw new ControlPlaneConflictError(`task ${input.taskId} does not belong to conversation ${input.conversationId}`);
      }
      if (
        taskRow.owner_user_id !== input.ownerUserId
        || taskRow.conversation_owner_user_id !== input.ownerUserId
      ) {
        throw new ControlPlaneAuthorizationError(`actor cannot control task ${input.taskId}`);
      }
      if (taskRow.state !== 'awaiting_clarification') {
        throw new ControlPlaneConflictError(`task ${input.taskId} is not awaiting clarification`);
      }
      if (asNumber(taskRow.state_version, 'state_version') !== input.expectedStateVersion) {
        throw new ControlPlaneConflictError(`task ${input.taskId} is not at version ${input.expectedStateVersion}`);
      }
      const structuredTask = asRecord(input.structuredTask);
      if (!input.taskType || !structuredTask || structuredTask.task_type !== input.taskType) {
        throw new ControlPlaneConflictError(`task ${input.taskId} has invalid finalized structured task`);
      }
      assertCompatibleCandidateSet(input.candidates, 'existing task planning');

      const preparedCandidates = input.candidates.map((candidate) => ({
        candidate,
        persistedPlan: planForTask(candidate.plan, input.taskId),
      }));
      for (const { persistedPlan } of preparedCandidates) {
        await validateProblemGraphReceipt(connection, JSON.parse(persistedPlan.json));
      }
      const planHashes = new Set<string>();
      for (const { persistedPlan } of preparedCandidates) {
        if (planHashes.has(persistedPlan.hash)) {
          throw new ControlPlaneConflictError(`candidate plan hash ${persistedPlan.hash} is duplicated`);
        }
        planHashes.add(persistedPlan.hash);
      }
      const versionResult = await connection.query(
        `SELECT COALESCE(MAX(version), 0) + 1 AS version
         FROM control_plan_versions
         WHERE task_id = $1`,
        [input.taskId],
      );
      const firstVersion = asNumber(versionResult.rows[0]?.version, 'version');

      const candidates: ControlCandidatePlanVersionDetail[] = [];
      for (const [index, { candidate, persistedPlan }] of preparedCandidates.entries()) {
        const planResult = await connection.query(
          `INSERT INTO control_plan_versions
             (task_id, version, candidate_id, plan_json, plan_hash, pending_inputs)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, task_id, version, candidate_id, plan_json, plan_hash, pending_inputs`,
          [
            input.taskId,
            firstVersion + index,
            candidate.candidateId,
            persistedPlan.json,
            persistedPlan.hash,
            JSON.stringify(candidate.pendingInputs),
          ],
        );
        const planRow = planResult.rows[0] ?? {};
        candidates.push({
          id: asString(planRow.id, 'id'),
          taskId: asString(planRow.task_id, 'task_id'),
          version: asNumber(planRow.version, 'version'),
          candidateId: asString(planRow.candidate_id, 'candidate_id') as ControlCandidateId,
          plan: planRow.plan_json as ReadableExecutionPlan,
          planHash: asString(planRow.plan_hash, 'plan_hash'),
          pendingInputs: planRow.pending_inputs as PendingInput[],
        });
      }

      const updated = await connection.query(
        `UPDATE control_tasks
         SET task_type = $2,
             structured_task = $3,
             state = 'awaiting_selection',
             state_version = state_version + 1,
             updated_at = now()
         WHERE id = $1
           AND state = 'awaiting_clarification'
           AND state_version = $4
         RETURNING id, state, state_version, active_plan_version_id, current_attempt_id`,
        [input.taskId, input.taskType, JSON.stringify(input.structuredTask), input.expectedStateVersion],
      );
      const updatedRow = updated.rows[0];
      if (!updatedRow) throw new ControlPlaneConflictError(`task ${input.taskId} lost planning CAS`);
      return {
        task: {
          id: asString(updatedRow.id, 'id'),
          state: asString(updatedRow.state, 'state') as ControlTaskState,
          stateVersion: asNumber(updatedRow.state_version, 'state_version'),
          activePlanVersionId: typeof updatedRow.active_plan_version_id === 'string' ? updatedRow.active_plan_version_id : null,
          currentAttemptId: typeof updatedRow.current_attempt_id === 'string' ? updatedRow.current_attempt_id : null,
        },
        candidates,
      };
    });
  }

  async persistClarificationCandidatesAndCompleteCommand(
    input: PersistClarificationCandidatesInput,
  ): Promise<ControlPlanCandidatesResponse> {
    if (input.clarificationRecovery) {
      if (input.expectedStateVersion !== input.command.expectedVersion) {
        throw new ControlPlaneConflictError(
          'latest finalized requirement recovery must use the command expected version',
        );
      }
    } else if (input.expectedStateVersion !== input.command.expectedVersion + 1) {
      throw new ControlPlaneConflictError('clarification planning state version is not activation successor');
    }
    return this.transaction(async (connection) => {
      const taskResult = await connection.query(
        `SELECT task.id, task.conversation_id, task.owner_user_id,
                conversation.owner_user_id AS conversation_owner_user_id,
                task.task_type, task.structured_task, task.state, task.state_version,
                task.active_plan_version_id, task.current_attempt_id,
                task.active_requirement_version_id
         FROM control_tasks AS task
         JOIN conversations AS conversation ON conversation.id = task.conversation_id
         WHERE task.id = $1
         FOR UPDATE OF task`,
        [input.taskId],
      );
      const taskRow = taskResult.rows[0];
      if (!taskRow) throw new ControlPlaneConflictError(`task ${input.taskId} does not exist`);
      if (taskRow.conversation_id !== input.conversationId) {
        throw new ControlPlaneConflictError(
          `task ${input.taskId} does not belong to conversation ${input.conversationId}`,
        );
      }
      if (
        taskRow.owner_user_id !== input.ownerUserId
        || taskRow.conversation_owner_user_id !== input.ownerUserId
      ) {
        throw new ControlPlaneAuthorizationError(`actor cannot control task ${input.taskId}`);
      }
      if (
        taskRow.state !== 'awaiting_clarification'
        || asNumber(taskRow.state_version, 'state_version') !== input.expectedStateVersion
      ) {
        throw new ControlPlaneConflictError(
          `task ${input.taskId} is not awaiting clarification at version ${input.expectedStateVersion}`,
        );
      }

      const commandResult = await connection.query(
        `SELECT request_hash, expected_version, actor_user_id, command_status, reservation_token
         FROM control_commands
         WHERE task_id = $1 AND command_type = $2 AND idempotency_key = $3
         FOR UPDATE`,
        [input.taskId, input.command.commandType, input.command.idempotencyKey],
      );
      const commandRow = commandResult.rows[0];
      if (
        !commandRow
        || commandRow.request_hash !== input.command.requestHash
        || asNumber(commandRow.expected_version, 'expected_version') !== input.command.expectedVersion
        || commandRow.actor_user_id !== input.command.actorUserId
        || input.command.actorUserId !== input.ownerUserId
        || commandRow.command_status !== 'pending'
        || commandRow.reservation_token !== input.command.reservationToken
      ) {
        throw new ControlPlaneConflictError('clarification command reservation fence was lost');
      }

      if (input.clarificationRecovery) {
        const activeRequirementVersionId = input.clarificationRecovery.activeRequirementVersionId;
        if (
          taskRow.active_requirement_version_id !== activeRequirementVersionId
          || !sameStoredValue(taskRow.structured_task, input.structuredTask)
        ) {
          throw new ControlPlaneConflictError(
            `task ${input.taskId} no longer matches the finalized requirement recovery`,
          );
        }
        const requirementResult = await connection.query(
          `SELECT task_id, structured_task_json
           FROM control_requirement_versions
           WHERE id = $1
           FOR SHARE`,
          [activeRequirementVersionId],
        );
        const requirementRow = requirementResult.rows[0];
        if (
          !requirementRow
          || requirementRow.task_id !== input.taskId
          || !sameStoredValue(requirementRow.structured_task_json, input.structuredTask)
          || !isFinalizedRequirement(input.structuredTask)
        ) {
          throw new ControlPlaneConflictError(
            `active requirement ${activeRequirementVersionId} is not the finalized recovery requirement`,
          );
        }
      }

      const structuredTask = asRecord(input.structuredTask);
      if (!structuredTask || structuredTask.task_type !== input.taskType) {
        throw new ControlPlaneConflictError(`task ${input.taskId} has invalid finalized structured task`);
      }
      assertCompatibleCandidateSet(input.candidates, 'clarification planning');
      const preparedCandidates = input.candidates.map((candidate) => ({
        candidate,
        persistedPlan: planForTask(candidate.plan, input.taskId),
      }));
      for (const { persistedPlan } of preparedCandidates) {
        await validateProblemGraphReceipt(connection, JSON.parse(persistedPlan.json));
      }
      const clarificationPlanHashes = new Set<string>();
      for (const { persistedPlan } of preparedCandidates) {
        if (clarificationPlanHashes.has(persistedPlan.hash)) {
          throw new ControlPlaneConflictError('clarification candidate plan hashes are duplicated');
        }
        clarificationPlanHashes.add(persistedPlan.hash);
      }
      const versionResult = await connection.query(
        `SELECT COALESCE(MAX(version), 0) + 1 AS version
         FROM control_plan_versions
         WHERE task_id = $1`,
        [input.taskId],
      );
      const firstVersion = asNumber(versionResult.rows[0]?.version, 'version');

      const persistedCandidates: Array<{
        candidate: PersistClarificationCandidatesInput['candidates'][number];
        stored: ControlCandidatePlanVersionDetail;
      }> = [];
      for (const [index, prepared] of preparedCandidates.entries()) {
        const planResult = await connection.query(
          `INSERT INTO control_plan_versions
             (task_id, version, candidate_id, plan_json, plan_hash, pending_inputs)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, task_id, version, candidate_id, plan_json, plan_hash, pending_inputs`,
          [
            input.taskId,
            firstVersion + index,
            prepared.candidate.candidateId,
            prepared.persistedPlan.json,
            prepared.persistedPlan.hash,
            JSON.stringify(prepared.candidate.pendingInputs),
          ],
        );
        const row = planResult.rows[0] ?? {};
        persistedCandidates.push({
          candidate: prepared.candidate,
          stored: {
            id: asString(row.id, 'id'),
            taskId: asString(row.task_id, 'task_id'),
            version: asNumber(row.version, 'version'),
            candidateId: asString(row.candidate_id, 'candidate_id') as ControlCandidateId,
            plan: row.plan_json as ReadableExecutionPlan,
            planHash: asString(row.plan_hash, 'plan_hash'),
            pendingInputs: row.pending_inputs as PendingInput[],
          },
        });
      }

      const updated = await connection.query(
        `UPDATE control_tasks
         SET task_type = $2,
             structured_task = $3,
             state = 'awaiting_selection',
             state_version = state_version + 1,
             updated_at = now()
         WHERE id = $1 AND state = 'awaiting_clarification' AND state_version = $4
         RETURNING id, state, state_version, active_plan_version_id, current_attempt_id`,
        [input.taskId, input.taskType, JSON.stringify(input.structuredTask), input.expectedStateVersion],
      );
      const updatedRow = updated.rows[0];
      if (!updatedRow) throw new ControlPlaneConflictError(`task ${input.taskId} lost planning CAS`);
      const response: ControlPlanCandidatesResponse = {
        kind: 'current',
        conversationId: input.conversationId,
        task: {
          id: asString(updatedRow.id, 'id'),
          state: asString(updatedRow.state, 'state') as ControlTaskState,
          stateVersion: asNumber(updatedRow.state_version, 'state_version'),
          activePlanVersionId: typeof updatedRow.active_plan_version_id === 'string'
            ? updatedRow.active_plan_version_id
            : null,
          currentAttemptId: typeof updatedRow.current_attempt_id === 'string'
            ? updatedRow.current_attempt_id
            : null,
          ...(input.orchestrationMode ? { orchestrationMode: input.orchestrationMode } : {}),
        },
        structuredTask: input.structuredTask,
        activatedNodes: input.activatedNodes,
        candidates: persistedCandidates.map(({ candidate, stored }) => ({
          planVersionId: stored.id,
          candidateId: stored.candidateId,
          title: candidate.title,
          rationale: candidate.rationale,
          tradeoffs: candidate.tradeoffs,
          planHash: stored.planHash,
          plan: stored.plan as ReadableExecutionPlan,
          pendingInputs: stored.pendingInputs,
        })),
      };
      const completed = await connection.query(
        `UPDATE control_commands
         SET state_after = 'awaiting_selection',
             response_json = $8,
             command_status = 'completed',
             reservation_token = NULL,
             reservation_expires_at = NULL
         WHERE task_id = $1 AND command_type = $2 AND idempotency_key = $3
           AND request_hash = $4 AND expected_version = $5
           AND command_status = 'pending' AND reservation_token = $6
           AND actor_user_id = $7
         RETURNING id`,
        [
          input.taskId,
          input.command.commandType,
          input.command.idempotencyKey,
          input.command.requestHash,
          input.command.expectedVersion,
          input.command.reservationToken,
          input.command.actorUserId,
          JSON.stringify(response),
        ],
      );
      if (!completed.rows[0]) {
        throw new ControlPlaneConflictError('clarification command reservation fence was lost');
      }
      return response;
    });
  }

  async selectCandidate(input: {
    taskId: string;
    planVersionId: string;
    expectedVersion: number;
    idempotencyKey: string;
    requestHash: string;
    actor: { userId: string; role: string };
  }): Promise<SelectionResponse> {
    return this.transaction(async (connection) => {
      const taskResult = await connection.query(
        `SELECT task.owner_user_id, conversation.owner_user_id AS conversation_owner_user_id,
                task.state, task.state_version, task.active_plan_version_id
         FROM control_tasks AS task
         JOIN conversations AS conversation ON conversation.id = task.conversation_id
         WHERE task.id = $1
         FOR UPDATE OF task`,
        [input.taskId],
      );
      const task = taskResult.rows[0];
      if (!task) throw new ControlPlaneConflictError(`task ${input.taskId} does not exist`);

      const commandResult = await connection.query(
        `SELECT request_hash, response_json
         FROM control_commands
         WHERE task_id = $1 AND command_type = 'selection' AND idempotency_key = $2`,
        [input.taskId, input.idempotencyKey],
      );
      const existingCommand = commandResult.rows[0];
      if (existingCommand) {
        if (existingCommand.request_hash !== input.requestHash) {
          throw new ControlPlaneConflictError(`idempotency key ${input.idempotencyKey} was reused with a different request`);
        }
        return selectionResponse(existingCommand.response_json);
      }

      if (
        task.owner_user_id !== input.actor.userId
        || task.conversation_owner_user_id !== input.actor.userId
        || input.actor.role !== 'owner'
      ) {
        throw new ControlPlaneAuthorizationError(`actor cannot control task ${input.taskId}`);
      }
      if (
        task.state !== 'awaiting_selection'
        || asNumber(task.state_version, 'state_version') !== input.expectedVersion
        || task.active_plan_version_id !== null
      ) {
        throw new ControlPlaneConflictError(`task ${input.taskId} is not awaiting selection at version ${input.expectedVersion}`);
      }

      const planResult = await connection.query(
        `SELECT id, task_id, version, candidate_id, plan_json, plan_hash
         FROM control_plan_versions
         WHERE task_id = $1
         ORDER BY version DESC
         LIMIT 8
         FOR UPDATE`,
        [input.taskId],
      );
      const plan = latestCandidateSet(planResult.rows).find((candidate) => (
        candidate.id === input.planVersionId
      ));
      if (!plan || plan.task_id !== input.taskId || typeof plan.candidate_id !== 'string') {
        throw new ControlPlaneConflictError(`plan version ${input.planVersionId} is not a candidate for task ${input.taskId}`);
      }
      const persistedPlan = asRecord(plan.plan_json);
      if (!persistedPlan || persistedPlan.task_id !== input.taskId) {
        throw new ControlPlaneConflictError(`plan version ${input.planVersionId} is not bound to task ${input.taskId}`);
      }
      if (canonicalPlanHash(persistedPlan) !== plan.plan_hash) {
        throw new ControlPlaneConflictError(`plan version ${input.planVersionId} hash does not match persisted plan`);
      }

      const updatedResult = await connection.query(
        `UPDATE control_tasks
         SET state = 'awaiting_confirmation',
             state_version = state_version + 1,
             active_plan_version_id = $2,
             updated_at = now()
         WHERE id = $1
           AND state = 'awaiting_selection'
           AND state_version = $3
           AND active_plan_version_id IS NULL
         RETURNING state, state_version`,
        [input.taskId, input.planVersionId, input.expectedVersion],
      );
      const updated = updatedResult.rows[0];
      if (!updated) throw new ControlPlaneConflictError(`task ${input.taskId} lost selection CAS`);
      const response: SelectionResponse = {
        planVersionId: input.planVersionId,
        state: asString(updated.state, 'state') as ControlTaskState,
        stateVersion: asNumber(updated.state_version, 'state_version'),
      };
      await connection.query(
        `INSERT INTO control_commands
           (task_id, command_type, idempotency_key, request_hash, expected_version,
            state_before, state_after, response_json, actor_user_id)
         VALUES ($1, $2, $3, $4, $5, 'awaiting_selection', 'awaiting_confirmation', $6, $7)`,
        [
          input.taskId,
          'selection',
          input.idempotencyKey,
          input.requestHash,
          input.expectedVersion,
          JSON.stringify(response),
          input.actor.userId,
        ],
      );
      return response;
    });
  }

  async createPlanVersion(input: {
    taskId: string;
    version: number;
    plan: unknown;
    planHash: string;
    candidateId?: string;
    pendingInputs?: unknown;
  }): Promise<ControlPlanVersion> {
    return this.transaction(async (connection) => {
      const taskResult = await connection.query(
        `SELECT 1 FROM control_tasks WHERE id = $1 FOR UPDATE`,
        [input.taskId],
      );
      if (!taskResult.rows[0]) {
        throw new ControlPlaneConflictError(`task ${input.taskId} does not exist`);
      }
      const planResult = await connection.query(
        `INSERT INTO control_plan_versions
           (task_id, version, candidate_id, plan_json, plan_hash, pending_inputs)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, task_id, version, plan_hash`,
        [
          input.taskId,
          input.version,
          input.candidateId ?? null,
          JSON.stringify(input.plan),
          input.planHash,
          JSON.stringify(input.pendingInputs ?? []),
        ],
      );
      const row = planResult.rows[0] ?? {};
      const plan = {
        id: asString(row.id, 'id'),
        taskId: asString(row.task_id, 'task_id'),
        version: asNumber(row.version, 'version'),
        planHash: asString(row.plan_hash, 'plan_hash'),
      };
      await connection.query(
        `UPDATE control_tasks
         SET active_plan_version_id = $2, updated_at = now()
         WHERE id = $1`,
        [input.taskId, plan.id],
      );
      return plan;
    });
  }

  async createPlanRevision(input: {
    taskId: string;
    expectedVersion: number;
    from: ControlTaskState | ControlTaskState[];
    to: ControlTaskState;
    plan: unknown;
    candidateId?: string;
    pendingInputs?: unknown;
    clearCurrentAttempt?: boolean;
  }): Promise<{ plan: ControlPlanVersion; task: ControlTask }> {
    const candidateId = input.candidateId;
    if (!isCandidateProfile(candidateId)) {
      throw new ControlPlaneConflictError('Current plan revision requires a controlled candidate profile');
    }
    const plan = asRecord(input.plan);
    if (!plan) throw new ControlPlaneConflictError('candidate revision plan must be an object');
    candidateMetadata(plan);
    candidateActivatedNodes(plan);
    return this.transaction(async (connection) => {
      const fromStates = Array.isArray(input.from) ? input.from : [input.from];
      const locked = await connection.query(
        `SELECT state, state_version, structured_task FROM control_tasks WHERE id = $1 FOR UPDATE`,
        [input.taskId],
      );
      const taskRow = locked.rows[0];
      if (
        !taskRow
        || !fromStates.includes(asString(taskRow.state, 'state') as ControlTaskState)
        || asNumber(taskRow.state_version, 'state_version') !== input.expectedVersion
      ) {
        throw new ControlPlaneConflictError(`task ${input.taskId} cannot revise at version ${input.expectedVersion}`);
      }
      await validateProblemGraphReceipt(connection, input.plan);
      const validatedPlan = validateCurrentPlanRevision({
        plan: input.plan,
        task: taskRow.structured_task,
        pending_inputs: input.pendingInputs ?? [],
        task_id: input.taskId,
        candidate_id: candidateId,
      });
      const persistedPlan = canonicalPlan(validatedPlan);
      const versionResult = await connection.query(
        `SELECT COALESCE(MAX(version), 0) + 1 AS version FROM control_plan_versions WHERE task_id = $1`,
        [input.taskId],
      );
      const version = asNumber(versionResult.rows[0]?.version, 'version');
      const inserted = await connection.query(
        `INSERT INTO control_plan_versions
           (task_id, version, candidate_id, plan_json, plan_hash, pending_inputs)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, task_id, version, plan_hash`,
        [
          input.taskId, version, input.candidateId ?? null, persistedPlan.json,
          persistedPlan.hash, JSON.stringify(input.pendingInputs ?? []),
        ],
      );
      const planRow = inserted.rows[0] ?? {};
      const plan: ControlPlanVersion = {
        id: asString(planRow.id, 'id'),
        taskId: asString(planRow.task_id, 'task_id'),
        version: asNumber(planRow.version, 'version'),
        planHash: asString(planRow.plan_hash, 'plan_hash'),
      };
      const updated = await connection.query(
        `UPDATE control_tasks
         SET state = $3, state_version = state_version + 1,
             active_plan_version_id = $4,
             current_attempt_id = CASE WHEN $6::boolean THEN NULL ELSE current_attempt_id END,
             updated_at = now()
         WHERE id = $1 AND state_version = $2 AND state = ANY($5::text[])
         RETURNING id, state, state_version, active_plan_version_id, current_attempt_id`,
        [input.taskId, input.expectedVersion, input.to, plan.id, fromStates, input.clearCurrentAttempt ?? false],
      );
      const row = updated.rows[0];
      if (!row) throw new ControlPlaneConflictError(`task ${input.taskId} lost revision CAS`);
      return {
        plan,
        task: {
          id: asString(row.id, 'id'),
          state: asString(row.state, 'state') as ControlTaskState,
          stateVersion: asNumber(row.state_version, 'state_version'),
          activePlanVersionId: typeof row.active_plan_version_id === 'string' ? row.active_plan_version_id : null,
          currentAttemptId: typeof row.current_attempt_id === 'string' ? row.current_attempt_id : null,
        },
      };
    });
  }

  async claimExecution(input: {
    taskId: string;
    planVersionId: string;
    expectedVersion: number;
    idempotencyKey: string;
    requestHash: string;
    leaseOwner: string;
    leaseTokenHash: string;
    leaseExpiresAt?: Date;
    retryOf?: string | null;
  }): Promise<ControlExecutionClaim> {
    return this.transaction(async (connection) => {
      const taskResult = await connection.query(
        `SELECT state, state_version, current_attempt_id
         FROM control_tasks
         WHERE id = $1
         FOR UPDATE`,
        [input.taskId],
      );
      const task = taskResult.rows[0];
      if (!task) throw new ControlPlaneConflictError(`task ${input.taskId} does not exist`);
      const planResult = await connection.query(
        `SELECT task_id FROM control_plan_versions WHERE id = $1 FOR KEY SHARE`,
        [input.planVersionId],
      );
      const plan = planResult.rows[0];
      if (!plan || plan.task_id !== input.taskId) {
        throw new ControlPlaneConflictError(`plan version ${input.planVersionId} does not belong to task ${input.taskId}`);
      }
      const commandResult = await connection.query(
        `SELECT request_hash, response_json
         FROM control_commands
         WHERE task_id = $1 AND command_type = 'execution_claim' AND idempotency_key = $2`,
        [input.taskId, input.idempotencyKey],
      );
      const existingCommand = commandResult.rows[0];
      if (existingCommand) {
        if (existingCommand.request_hash !== input.requestHash) {
          throw new ControlPlaneConflictError(`idempotency key ${input.idempotencyKey} was reused with a different request`);
        }
        return { ...commandResponse(existingCommand.response_json), replayed: true };
      }
      if (task.state !== 'ready' || asNumber(task.state_version, 'state_version') !== input.expectedVersion) {
        throw new ControlPlaneConflictError(`task ${input.taskId} is no longer ready at version ${input.expectedVersion}`);
      }
      const retryOf = input.retryOf ?? (typeof task.current_attempt_id === 'string' ? task.current_attempt_id : null);
      if (retryOf) {
        const previousAttempt = await connection.query(
          `SELECT task_id FROM control_execution_attempts WHERE id = $1 FOR KEY SHARE`,
          [retryOf],
        );
        if (!previousAttempt.rows[0] || previousAttempt.rows[0].task_id !== input.taskId) {
          throw new ControlPlaneConflictError(`retry attempt ${retryOf} does not belong to task ${input.taskId}`);
        }
      }
      const nextAttemptResult = await connection.query(
        `SELECT COALESCE(MAX(attempt_no), 0) + 1 AS attempt_no
         FROM control_execution_attempts WHERE task_id = $1`,
        [input.taskId],
      );
      const attemptNo = asNumber(nextAttemptResult.rows[0]?.attempt_no, 'attempt_no');
      const expiresAt = input.leaseExpiresAt ?? new Date(Date.now() + 5 * 60 * 1000);
      const attemptResult = await connection.query(
        `INSERT INTO control_execution_attempts
           (task_id, plan_version_id, attempt_no, state, retry_of,
            lease_owner, lease_token_hash, lease_expires_at, lease_heartbeat_at)
         VALUES ($1, $2, $3, 'active', $4, $5, $6, $7, now())
         RETURNING id`,
        [input.taskId, input.planVersionId, attemptNo, retryOf, input.leaseOwner, input.leaseTokenHash, expiresAt],
      );
      const attemptId = asString(attemptResult.rows[0]?.id, 'attempt_id');
      const updatedTask = await connection.query(
        `UPDATE control_tasks
         SET state = 'executing', state_version = state_version + 1,
             current_attempt_id = $2, active_plan_version_id = $3, updated_at = now()
         WHERE id = $1 AND state = 'ready' AND state_version = $4
         RETURNING state_version`,
        [input.taskId, attemptId, input.planVersionId, input.expectedVersion],
      );
      const stateVersion = asNumber(updatedTask.rows[0]?.state_version, 'state_version');
      const response: CommandResponse = { attemptId, stateVersion };
      await connection.query(
        `INSERT INTO control_commands
           (task_id, command_type, idempotency_key, request_hash, expected_version, state_before, state_after, response_json)
         VALUES ($1, 'execution_claim', $2, $3, $4, 'ready', 'executing', $5)`,
        [input.taskId, input.idempotencyKey, input.requestHash, input.expectedVersion, JSON.stringify(response)],
      );
      return { ...response, replayed: false };
    });
  }

  async listAttempts(taskId: string): Promise<Array<{ id: string; state: string }>> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        `SELECT id, state
         FROM control_execution_attempts
         WHERE task_id = $1
         ORDER BY attempt_no`,
        [taskId],
      );
      return result.rows.map((row) => ({ id: asString(row.id, 'id'), state: asString(row.state, 'state') }));
    } finally {
      connection.release();
    }
  }
  async listRecoverableExecutions(): Promise<Array<{
    taskId: string;
    planVersionId: string;
    attemptId: string;
    taskState: string;
    attemptState: string;
    leaseExpiresAt: Date;
    failureKind?: string;
  }>> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        `SELECT task.id AS task_id, task.state AS task_state,
                attempt.plan_version_id, attempt.id AS attempt_id,
                attempt.state AS attempt_state, attempt.lease_expires_at,
                attempt.failure_kind
         FROM control_execution_attempts AS attempt
         JOIN control_tasks AS task ON task.id = attempt.task_id
         WHERE (
           task.current_attempt_id = attempt.id
           AND task.active_plan_version_id = attempt.plan_version_id
           AND task.state IN ('executing', 'reviewing', 'composing_report')
           AND attempt.state = 'active'
         ) OR (
           attempt.failure_kind IN ('worker_loss', 'artifact_invalidation')
           AND attempt.state IN ('paused', 'cancelled')
           AND EXISTS (
             SELECT 1
             FROM control_artifacts AS artifact
             WHERE artifact.attempt_id = attempt.id
               AND (
                 artifact.state = 'STAGING'
                 OR (
                   artifact.state = 'FAILED'
                   AND artifact.failure_reason LIKE '%' || $1 || '%'
                 )
                 OR (
                   artifact.state = 'SEALED'
                   AND artifact.kind IN (
                     'evidence_manifest', 'deliverable', 'report_review', 'report_document',
                     'report_package', 'report_editorial_showcase_spec', 'editorial_showcase_html',
                     'cross_skill_review', 'contribution_ledger', 'contribution_summary',
                     'research_contribution_bundle',
                     'visual_asset', 'visual_asset_manifest',
                     'image_annotation', 'chart_spec', 'chart_data'
                   )
                 )
                 OR (
                   artifact.state = 'SEALED'
                   AND artifact.kind IN ('knowledge_output', 'tool_output', 'skill_output', 'research_contribution', 'llm_output', 'review_output')
                   AND NOT EXISTS (
                     SELECT 1
                     FROM control_execution_steps AS step
                     WHERE step.attempt_id = attempt.id
                       AND step.state = 'succeeded'
                       AND (
                         step.output_artifact_id = artifact.id
                         OR step.skill_provenance->>'sourceArtifactId' = artifact.id::text
                       )
                   )
                 )
               )
           )
         )
         ORDER BY attempt.attempt_no`,
        [ARTIFACT_QUARANTINE_PENDING_MARKER],
      );
      return result.rows.map((row) => ({
        taskId: asString(row.task_id, 'task_id'),
        planVersionId: asString(row.plan_version_id, 'plan_version_id'),
        attemptId: asString(row.attempt_id, 'attempt_id'),
        taskState: asString(row.task_state, 'task_state'),
        attemptState: asString(row.attempt_state, 'attempt_state'),
        leaseExpiresAt: asDate(row.lease_expires_at, 'lease_expires_at'),
        failureKind: typeof row.failure_kind === 'string' ? row.failure_kind : undefined,
      }));
    } finally {
      connection.release();
    }
  }

  async quarantineStagingArtifact(
    input: {
      artifactId: string;
      expectedStorageUri: string;
      quarantineUri: string;
      reason: string;
    },
    prepare: () => Promise<'moved' | 'already_moved' | 'absent'>,
  ): Promise<ControlArtifact | null> {
    return this.transaction(async (connection) => {
      const paths = [...new Set([input.expectedStorageUri, input.quarantineUri])].sort();
      for (const path of paths) {
        await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [path]);
      }
      const locked = await connection.query(
        `SELECT *
         FROM control_artifacts
         WHERE id = $1
         FOR UPDATE`,
        [input.artifactId],
      );
      const row = locked.rows[0];
      if (!row) return null;
      const pendingPhysicalMove = row.state === 'FAILED'
        && row.storage_uri === input.quarantineUri
        && typeof row.failure_reason === 'string'
        && row.failure_reason.includes(ARTIFACT_QUARANTINE_PENDING_MARKER);
      if (!pendingPhysicalMove && (
        row.state !== 'STAGING'
        || row.storage_uri !== input.expectedStorageUri
      )) return null;

      if (pendingPhysicalMove) {
        const liveOwner = await connection.query(
          `SELECT id
           FROM control_artifacts
           WHERE storage_uri = $1
             AND id <> $2
             AND state IN ('STAGING', 'SEALED')
           ORDER BY created_at, id
           LIMIT 1`,
          [input.expectedStorageUri, input.artifactId],
        );
        if (liveOwner.rows[0]) {
          const ownerId = asString(liveOwner.rows[0].id, 'artifact_id');
          const reused = await connection.query(
            `UPDATE control_artifacts
             SET failure_reason = $2
             WHERE id = $1
               AND state = 'FAILED'
               AND storage_uri = $3
             RETURNING *`,
            [
              input.artifactId,
              `${input.reason}; source path reused by live artifact ${ownerId}`,
              input.quarantineUri,
            ],
          );
          return reused.rows[0] ? artifactFromRow(reused.rows[0]) : null;
        }
      }

      const disposition = await prepare();
      const storageUri = input.quarantineUri;
      const failureReason = disposition === 'absent'
        ? `${input.reason}${ARTIFACT_QUARANTINE_PENDING_MARKER}${input.expectedStorageUri}`
        : `${input.reason}; file quarantined at ${input.quarantineUri}`;
      if (pendingPhysicalMove) {
        if (disposition === 'absent') return artifactFromRow(row);
        const completed = await connection.query(
          `UPDATE control_artifacts
           SET failure_reason = $2
           WHERE id = $1
             AND state = 'FAILED'
             AND storage_uri = $3
           RETURNING *`,
          [input.artifactId, failureReason, input.quarantineUri],
        );
        return completed.rows[0] ? artifactFromRow(completed.rows[0]) : null;
      }
      const updated = await connection.query(
        `UPDATE control_artifacts
         SET storage_uri = $2,
             state = 'FAILED',
             failure_reason = $3,
             redaction_status = 'failed'
         WHERE id = $1
           AND state = 'STAGING'
           AND storage_uri = $4
         RETURNING *`,
        [input.artifactId, storageUri, failureReason, input.expectedStorageUri],
      );
      return updated.rows[0] ? artifactFromRow(updated.rows[0]) : null;
    });
  }


  async createStagingArtifact(input: {
    artifactId?: string;
    taskId: string;
    planVersionId?: string;
    attemptId?: string;
    publicationId?: string;
    activeLease?: ControlExecutionLease;
    kind: string;
    storageUri: string;
    schemaVersion: string;
    sensitivity: string;
    redactionPolicyVersion: string;
    mediaType?: string;
    metadata?: Record<string, unknown>;
  }): Promise<ControlArtifact> {
    const artifactId = input.artifactId ?? randomUUID();
    return this.transaction(async (connection) => {
      await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [input.storageUri]);
      const livePath = await connection.query(
        `SELECT id FROM control_artifacts
         WHERE storage_uri = $1 AND state IN ('STAGING', 'SEALED')
         LIMIT 1`,
        [input.storageUri],
      );
      if (livePath.rows[0]) {
        throw new ControlPlaneConflictError(`artifact path ${input.storageUri} already has a live owner`);
      }
      if (input.planVersionId) {
        const plan = await connection.query(
          'SELECT 1 FROM control_plan_versions WHERE id = $1 AND task_id = $2',
          [input.planVersionId, input.taskId],
        );
        if (!plan.rows[0]) {
          throw new ControlPlaneConflictError(`plan version ${input.planVersionId} does not belong to task ${input.taskId}`);
        }
      }
      if (input.attemptId) {
        if (!input.planVersionId) throw new ControlPlaneConflictError('attempt-bound artifact requires a plan version');
        const lease = input.activeLease;
        if (
          !lease
          || lease.taskId !== input.taskId
          || lease.planVersionId !== input.planVersionId
          || lease.attemptId !== input.attemptId
        ) {
          throw new ControlPlaneConflictError('attempt-bound artifact requires its active execution lease');
        }
        const task = await connection.query(
          `SELECT 1 FROM control_tasks
           WHERE id = $1
             AND state IN ('executing', 'reviewing', 'composing_report')
             AND current_attempt_id = $2
             AND active_plan_version_id = $3
           FOR UPDATE`,
          [input.taskId, input.attemptId, input.planVersionId],
        );
        if (!task.rows[0]) {
          throw new ControlPlaneConflictError(`task ${input.taskId} is not executing artifact attempt ${input.attemptId}`);
        }
        const attempt = await connection.query(
          `SELECT 1 FROM control_execution_attempts
           WHERE id = $1
             AND task_id = $2
             AND plan_version_id = $3
             AND lease_owner = $4
             AND lease_token_hash = $5
             AND state = 'active'
             AND lease_expires_at > now()
           FOR UPDATE`,
          [
            input.attemptId,
            input.taskId,
            input.planVersionId,
            lease.leaseOwner,
            hashLeaseToken(lease.leaseToken),
          ],
        );
        if (!attempt.rows[0]) {
          throw new ControlPlaneConflictError(`execution lease ${input.attemptId} cannot create a staging artifact`);
        }
      } else if (input.activeLease) {
        throw new ControlPlaneConflictError('unbound artifact cannot carry an execution lease');
      }
      if (input.publicationId) {
        if (!input.planVersionId || input.attemptId) {
          throw new ControlPlaneConflictError('publication artifact requires a plan version and no execution attempt');
        }
        if (input.kind !== 'visual_input_image' && input.kind !== 'visual_input_gate') {
          throw new ControlPlaneConflictError('visual publication contains an unsupported Artifact kind');
        }
        const publication = await connection.query(
          `SELECT 1 FROM control_visual_publications
           WHERE id = $1 AND task_id = $2 AND plan_version_id = $3 AND state = 'PUBLISHING'
           FOR UPDATE`,
          [input.publicationId, input.taskId, input.planVersionId],
        );
        if (!publication.rows[0]) {
          throw new ControlPlaneConflictError(`visual publication ${input.publicationId} is not publishing for artifact task and plan`);
        }
      }
      const result = await connection.query(
        `INSERT INTO control_artifacts
           (id, task_id, plan_version_id, attempt_id, publication_id, kind, contract_version, schema_version, state,
            storage_uri, sensitivity, redaction_policy_version, media_type, metadata_json)
         VALUES ($1, $2, $3, $4, $5, $6, 'trusted-p0-v1', $7, 'STAGING', $8, $9, $10, $11, $12)
         RETURNING *`,
        [
          artifactId,
          input.taskId,
          input.planVersionId ?? null,
          input.attemptId ?? null,
          input.publicationId ?? null,
          input.kind,
          input.schemaVersion,
          input.storageUri,
          input.sensitivity,
          input.redactionPolicyVersion,
          input.mediaType ?? null,
          input.metadata ? JSON.stringify(input.metadata) : null,
        ],
      );
      return artifactFromRow(result.rows[0] ?? {});
    });
  }

  async sealArtifact(input: {
    artifactId: string;
    contentSha256: string;
    byteSize: number;
  } & Partial<ControlExecutionLease>): Promise<ControlArtifact> {
    const leaseFieldCount = [
      input.taskId,
      input.planVersionId,
      input.attemptId,
      input.leaseOwner,
      input.leaseToken,
    ].filter((value) => value !== undefined).length;
    if (leaseFieldCount !== 0 && leaseFieldCount !== 5) {
      throw new ControlPlaneConflictError('artifact seal execution lease must be complete');
    }
    const leaseBound = leaseFieldCount === 5;
    const outcome = await this.transaction(async (connection) => {
      const bindingResult = await connection.query(
        `SELECT artifact.task_id, artifact.plan_version_id, artifact.attempt_id,
                artifact.publication_id, artifact.storage_uri,
                plan.task_id AS plan_task_id,
                attempt.task_id AS attempt_task_id,
                attempt.plan_version_id AS attempt_plan_version_id
         FROM control_artifacts AS artifact
         LEFT JOIN control_plan_versions AS plan ON plan.id = artifact.plan_version_id
         LEFT JOIN control_execution_attempts AS attempt ON attempt.id = artifact.attempt_id
         WHERE artifact.id = $1 AND artifact.state = 'STAGING'`,
        [input.artifactId],
      );
      const binding = bindingResult.rows[0];
      if (!binding) return null;
      const storageUri = asString(binding.storage_uri, 'storage_uri');
      await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [storageUri]);
      const competingPath = await connection.query(
        `SELECT id FROM control_artifacts
         WHERE storage_uri = $1
           AND id <> $2
           AND state IN ('STAGING', 'SEALED')
         LIMIT 1`,
        [storageUri, input.artifactId],
      );
      if (competingPath.rows[0]) return null;
      const taskId = asString(binding.task_id, 'task_id');
      const planVersionId = typeof binding.plan_version_id === 'string' ? binding.plan_version_id : null;
      const attemptId = typeof binding.attempt_id === 'string' ? binding.attempt_id : null;
      const validPlan = planVersionId === null || binding.plan_task_id === taskId;
      const validAttempt = attemptId === null || (
        planVersionId !== null
        && binding.attempt_task_id === taskId
        && binding.attempt_plan_version_id === planVersionId
      );
      if (!validPlan || !validAttempt) return null;
      const publicationId = typeof binding.publication_id === 'string' ? binding.publication_id : null;
      if (leaseBound) {
        if (
          publicationId !== null
          || planVersionId === null
          || attemptId === null
          || input.taskId !== taskId
          || input.planVersionId !== planVersionId
          || input.attemptId !== attemptId
        ) return null;
        await connection.query(
          'SELECT 1 FROM control_tasks WHERE id = $1 FOR UPDATE',
          [taskId],
        );
        await connection.query(
          `SELECT 1 FROM control_execution_attempts
           WHERE id = $1 AND task_id = $2 AND plan_version_id = $3
           FOR UPDATE`,
          [attemptId, taskId, planVersionId],
        );
      }
      if (publicationId) {
        const publication = await connection.query(
          `SELECT state FROM control_visual_publications
           WHERE id = $1
           FOR UPDATE`,
          [publicationId],
        );
        if (publication.rows[0]?.state !== 'PUBLISHING') {
          await connection.query(
            `UPDATE control_artifacts
             SET state = 'FAILED',
                 failure_reason = 'visual publication is no longer publishing',
                 redaction_status = 'failed'
             WHERE id = $1 AND state = 'STAGING'`,
            [input.artifactId],
          );
          return null;
        }
      }
      const result = leaseBound
        ? await connection.query(
            `UPDATE control_artifacts AS artifact
             SET state = 'SEALED',
                 content_sha256 = $2,
                 byte_size = $3,
                 sealed_at = now(),
                 redaction_status = 'sealed'
             FROM control_execution_attempts AS attempt, control_tasks AS task
             WHERE artifact.id = $1
               AND artifact.state = 'STAGING'
               AND artifact.task_id = $4
               AND artifact.plan_version_id = $5
               AND artifact.attempt_id = $6
               AND attempt.id = $6
               AND attempt.task_id = $4
               AND attempt.plan_version_id = $5
               AND attempt.lease_owner = $7
               AND attempt.lease_token_hash = $8
               AND attempt.state = 'active'
               AND attempt.lease_expires_at > now()
               AND task.id = $4
               AND task.state IN ('executing', 'reviewing', 'composing_report')
               AND task.current_attempt_id = attempt.id
               AND task.active_plan_version_id = attempt.plan_version_id
             RETURNING artifact.*`,
            [
              input.artifactId,
              input.contentSha256,
              input.byteSize,
              input.taskId,
              input.planVersionId,
              input.attemptId,
              input.leaseOwner,
              hashLeaseToken(input.leaseToken!),
            ],
          )
        : leaseFieldCount === 0
          ? await connection.query(
              `UPDATE control_artifacts AS artifact
               SET state = 'SEALED',
                   content_sha256 = $2,
                   byte_size = $3,
                   sealed_at = now(),
                   redaction_status = 'sealed'
               WHERE id = $1 AND state = 'STAGING'
                 AND artifact.attempt_id IS NULL
                 AND (
                   artifact.publication_id IS NULL
                   OR EXISTS (
                     SELECT 1 FROM control_visual_publications AS publication
                     WHERE publication.id = artifact.publication_id
                       AND publication.state = 'PUBLISHING'
                   )
                 )
               RETURNING *`,
              [input.artifactId, input.contentSha256, input.byteSize],
            )
          : { rows: [] };
      if (result.rows[0]) return artifactFromRow(result.rows[0]);

      if (leaseBound) {
        await connection.query(
          `UPDATE control_artifacts
           SET state = 'FAILED',
               failure_reason = 'active execution lease is invalid or expired',
               redaction_status = 'failed'
           WHERE id = $1 AND state = 'STAGING'`,
          [input.artifactId],
        );
        await this.pauseExpiredExecutionLease(connection, {
          taskId: input.taskId!,
          planVersionId: input.planVersionId!,
          attemptId: input.attemptId!,
          leaseOwner: input.leaseOwner!,
          leaseToken: input.leaseToken!,
        });
      }
      return null;
    });
    if (!outcome) throw new ControlPlaneConflictError(`artifact ${input.artifactId} cannot be sealed`);
    return outcome;
  }

  async failArtifact(artifactId: string, reason: string): Promise<void> {
    await this.transaction(async (connection) => {
      await connection.query(
        `UPDATE control_artifacts
         SET state = 'FAILED', failure_reason = $2
         WHERE id = $1 AND state = 'STAGING'`,
        [artifactId, reason],
      );
    });
  }

  async invalidateTerminalArtifacts(input: {
    taskId: string;
    planVersionId: string;
    attemptId: string;
    reason: string;
  }): Promise<void> {

    await this.transaction(async (connection) => {
      await connection.query(
        `UPDATE control_artifacts
         SET state = 'FAILED', failure_reason = $4, redaction_status = 'failed'
         WHERE task_id = $1
           AND plan_version_id = $2
           AND attempt_id = $3
           AND kind IN (
             'evidence_manifest', 'deliverable', 'report_document', 'report_review', 'report_package',
             'report_layout_blueprint', 'report_editorial_blueprint', 'standalone_html_report',
             'report_editorial_showcase_spec', 'editorial_showcase_html',
             'deliverable_validation_diagnostic', 'content_fidelity_diagnostic',
             'cross_skill_review', 'contribution_ledger', 'contribution_summary',
             'research_contribution_bundle',
             'final_report', 'final_report_primary', 'final_report_attachment',
             'final_report_html', 'report_sources',
             'skill_result', 'skill_result_primary', 'skill_result_attachment',
             'visual_asset', 'visual_asset_manifest', 'image_annotation', 'chart_spec', 'chart_data'
           )
           AND state IN ('STAGING', 'SEALED')`,
        [input.taskId, input.planVersionId, input.attemptId, input.reason],
      );
    });
  }
  async invalidateArtifactPublication(artifactId: string, reason: string): Promise<void> {
    await this.transaction(async (connection) => {
      await connection.query(
        `UPDATE control_artifacts
         SET state = 'FAILED', failure_reason = $2, redaction_status = 'failed'
         WHERE id = $1 AND state IN ('STAGING', 'SEALED')`,
        [artifactId, reason],
      );
    });
  }

  async getArtifact(artifactId: string): Promise<ControlArtifact | null> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(`SELECT * FROM control_artifacts WHERE id = $1`, [artifactId]);
      return result.rows[0] ? artifactFromRow(result.rows[0]) : null;
    } finally {
      connection.release();
    }
  }

  async findSealedArtifact(input: {
    taskId: string;
    attemptId: string;
    kind: string;
  }): Promise<ControlArtifact | null> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        `SELECT *
         FROM control_artifacts
         WHERE task_id = $1 AND attempt_id = $2 AND kind = $3 AND state = 'SEALED'
         ORDER BY created_at DESC
         LIMIT 1`,
        [input.taskId, input.attemptId, input.kind],
      );
      return result.rows[0] ? artifactFromRow(result.rows[0]) : null;
    } finally {
      connection.release();
    }
  }

  async listArtifactsForAttempt(input: {
    taskId: string;
    planVersionId: string;
    attemptId: string;
    kinds?: string[];
  }): Promise<ControlArtifact[]> {
    if (input.kinds?.length === 0) return [];
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        `SELECT *
         FROM control_artifacts
         WHERE task_id = $1
           AND plan_version_id = $2
           AND attempt_id = $3
           AND ($4::text[] IS NULL OR kind = ANY($4::text[]))
         ORDER BY created_at, id`,
        [input.taskId, input.planVersionId, input.attemptId, input.kinds ?? null],
      );
      return result.rows.map(artifactFromRow);
    } finally {
      connection.release();
    }
  }

  async requireSealedArtifact(artifactId: string): Promise<ControlArtifact> {
    const artifact = await this.getArtifact(artifactId);
    if (!artifact || artifact.state !== 'SEALED') throw new ArtifactNotSealedError(artifactId);
    return artifact;
  }

  async requireSealedArtifactBinding(artifactId: string): Promise<ControlArtifact> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        `SELECT artifact.*,
                plan.task_id AS binding_plan_task_id,
                attempt.task_id AS binding_attempt_task_id,
                attempt.plan_version_id AS binding_attempt_plan_version_id
         FROM control_artifacts AS artifact
         LEFT JOIN control_plan_versions AS plan ON plan.id = artifact.plan_version_id
         LEFT JOIN control_execution_attempts AS attempt ON attempt.id = artifact.attempt_id
         WHERE artifact.id = $1 AND artifact.state = 'SEALED'`,
        [artifactId],
      );
      const row = result.rows[0];
      if (!row) throw new ArtifactNotSealedError(artifactId);
      const taskId = asString(row.task_id, 'task_id');
      const planVersionId = typeof row.plan_version_id === 'string' ? row.plan_version_id : null;
      const attemptId = typeof row.attempt_id === 'string' ? row.attempt_id : null;
      if (
        !planVersionId
        || row.binding_plan_task_id !== taskId
        || (attemptId !== null && (
          row.binding_attempt_task_id !== taskId
          || row.binding_attempt_plan_version_id !== planVersionId
        ))
      ) {
        throw new ControlPlaneConflictError(`artifact ${artifactId} identity binding is invalid`);
      }
      return artifactFromRow(row);
    } finally {
      connection.release();
    }
  }

  async listArtifactsByStorageUri(storageUri: string): Promise<ControlArtifact[]> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        'SELECT * FROM control_artifacts WHERE storage_uri = $1 ORDER BY created_at, id',
        [storageUri],
      );
      return result.rows.map(artifactFromRow);
    } finally {
      connection.release();
    }
  }

  async listStagingArtifacts(): Promise<ControlArtifact[]> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(`SELECT * FROM control_artifacts WHERE state = 'STAGING' ORDER BY created_at`);
      return result.rows.map(artifactFromRow);
    } finally {
      connection.release();
    }
  }
  async listTasksForOwner(input: {
    ownerUserId: string;
    limit?: number;
  }): Promise<ControlTaskSummary[]> {
    const connection = await this.database.connect();
    try {
      const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
      const result = await connection.query(
        `SELECT task.id, task.original_input, task.task_type, task.state,
                task.created_at, task.updated_at
         FROM control_tasks AS task
         JOIN conversations AS conversation ON conversation.id = task.conversation_id
         WHERE task.owner_user_id = $1
           AND conversation.owner_user_id = $1
         ORDER BY task.created_at DESC, task.id DESC
         LIMIT $2`,
        [input.ownerUserId, limit],
      );
      return result.rows.map(controlTaskSummaryFromRow);
    } finally {
      connection.release();
    }
  }

  async listTasksAwaitingApproval(limit = 100): Promise<ControlTaskDetail[]> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        `SELECT task.id, task.conversation_id, task.original_input, task.owner_user_id,
                conversation.owner_user_id AS conversation_owner_user_id,
                task.structured_task, task.state, task.state_version,
                task.active_plan_version_id, task.current_attempt_id,
                task.active_requirement_version_id
         FROM control_tasks AS task
         JOIN conversations AS conversation ON conversation.id = task.conversation_id
         WHERE task.state = 'awaiting_approval'
         ORDER BY task.updated_at DESC, task.id DESC
         LIMIT $1`,
        [Math.min(Math.max(limit, 1), 100)],
      );
      return result.rows.map(controlTaskDetailFromRow);
    } finally {
      connection.release();
    }
  }

  async getTaskDetail(taskId: string): Promise<ControlTaskDetail | null> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        `SELECT task.id, task.conversation_id, task.original_input, task.owner_user_id, conversation.owner_user_id AS conversation_owner_user_id,
                task.structured_task, task.state, task.state_version, task.active_plan_version_id,
                task.current_attempt_id, task.active_requirement_version_id,
                task.orchestration_mode
         FROM control_tasks AS task
         JOIN conversations AS conversation ON conversation.id = task.conversation_id
         WHERE task.id = $1`,
        [taskId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return controlTaskDetailFromRow(row);
    } finally {
      connection.release();
    }
  }

  async listCandidatePlanVersionsForOwner(input: {
    taskId: string;
    ownerUserId: string;
  }): Promise<{ candidates: CurrentPlanCandidate[]; activatedNodes: string[] } | null> {
    return this.transaction(async (connection) => {
      const taskResult = await connection.query(
        `SELECT task.state, task.owner_user_id,
                conversation.owner_user_id AS conversation_owner_user_id
         FROM control_tasks AS task
         JOIN conversations AS conversation ON conversation.id = task.conversation_id
         WHERE task.id = $1
         FOR KEY SHARE OF task`,
        [input.taskId],
      );
      const task = taskResult.rows[0];
      if (
        !task
        || task.owner_user_id !== input.ownerUserId
        || task.conversation_owner_user_id !== input.ownerUserId
      ) {
        return null;
      }
      if (task.state !== 'awaiting_selection') {
        throw new ControlPlaneConflictError(`task ${input.taskId} is not awaiting_selection`);
      }

      const result = await connection.query(
        `SELECT id, task_id, version, candidate_id, plan_json, plan_hash, pending_inputs
         FROM control_plan_versions
         WHERE task_id = $1
         ORDER BY version DESC
         LIMIT 8`,
        [input.taskId],
      );
      const rows = latestCandidateSet(result.rows);

      let activatedNodes: string[] | null = null;
      const candidates = rows.map((row): CurrentPlanCandidate => {
        const candidate = currentPlanCandidateFromRow(row, input.taskId);
        const candidateNodes = candidate.plan.activated_nodes;
        if (activatedNodes === null) {
          activatedNodes = candidateNodes;
        } else if (JSON.stringify(activatedNodes) !== JSON.stringify(candidateNodes)) {
          throw new ControlPlaneConflictError('candidate activated_nodes do not match');
        }
        return candidate;
      });
      return { candidates, activatedNodes: activatedNodes ?? [] };
    });
  }

  async getActivePlanForOwner(input: {
    taskId: string;
    ownerUserId: string;
  }): Promise<CurrentPlanCandidate | null> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        `SELECT plan.id, plan.task_id, plan.version, plan.candidate_id,
                plan.plan_json, plan.plan_hash, plan.pending_inputs
         FROM control_tasks AS task
         JOIN conversations AS conversation ON conversation.id = task.conversation_id
         JOIN control_plan_versions AS plan ON plan.id = task.active_plan_version_id
         WHERE task.id = $1
           AND task.owner_user_id = $2
           AND conversation.owner_user_id = $2`,
        [input.taskId, input.ownerUserId],
      );
      const row = result.rows[0];
      return row ? currentPlanCandidateFromRow(row, input.taskId) : null;
    } finally {
      connection.release();
    }
  }

  async getActivePlan(taskId: string): Promise<CurrentPlanCandidate | null> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        `SELECT id, task_id, version, candidate_id,
                plan_json, plan_hash, pending_inputs
         FROM control_plan_versions
         WHERE id = (SELECT active_plan_version_id FROM control_tasks WHERE id = $1)`,
        [taskId],
      );
      const row = result.rows[0];
      return row ? currentPlanCandidateFromRow(row, taskId) : null;
    } finally {
      connection.release();
    }
  }

  async getPlanVersionDetail(planVersionId: string): Promise<ControlPlanVersionDetail | null> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        `SELECT id, task_id, version, candidate_id, plan_json, plan_hash, pending_inputs
         FROM control_plan_versions WHERE id = $1`,
        [planVersionId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        id: asString(row.id, 'id'),
        taskId: asString(row.task_id, 'task_id'),
        version: asNumber(row.version, 'version'),
        candidateId: typeof row.candidate_id === 'string' ? row.candidate_id : null,
        plan: row.plan_json,
        planHash: asString(row.plan_hash, 'plan_hash'),
        pendingInputs: row.pending_inputs,
      };
    } finally {
      connection.release();
    }
  }

  async isPlanPendingInputQuarantined(planVersionId: string): Promise<boolean> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        `SELECT pending_input_quarantined
         FROM control_plan_versions WHERE id = $1`,
        [planVersionId],
      );
      return result.rows[0]?.pending_input_quarantined === true;
    } finally {
      connection.release();
    }
  }

  async nextPlanVersion(taskId: string): Promise<number> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        `SELECT COALESCE(MAX(version), 0) + 1 AS version FROM control_plan_versions WHERE task_id = $1`,
        [taskId],
      );
      return asNumber(result.rows[0]?.version, 'version');
    } finally {
      connection.release();
    }
  }

  async transitionTask(input: {
    taskId: string;
    expectedVersion: number;
    from: ControlTaskState | ControlTaskState[];
    to: ControlTaskState;
    activePlanVersionId?: string;
  }): Promise<ControlTask> {
    return this.transaction(async (connection) => {
      const fromStates = Array.isArray(input.from) ? input.from : [input.from];
      const result = await connection.query(
        `UPDATE control_tasks
         SET state = $3,
             state_version = state_version + 1,
             active_plan_version_id = COALESCE($4, active_plan_version_id),
             updated_at = now()
         WHERE id = $1 AND state_version = $2 AND state = ANY($5::text[])
         RETURNING id, state, state_version, active_plan_version_id, current_attempt_id`,
        [input.taskId, input.expectedVersion, input.to, input.activePlanVersionId ?? null, fromStates],
      );
      const row = result.rows[0];
      if (!row) throw new ControlPlaneConflictError(`task ${input.taskId} is not ${fromStates.join(' or ')} at version ${input.expectedVersion}`);
      return {
        id: asString(row.id, 'id'),
        state: asString(row.state, 'state') as ControlTaskState,
        stateVersion: asNumber(row.state_version, 'state_version'),
        activePlanVersionId: typeof row.active_plan_version_id === 'string' ? row.active_plan_version_id : null,
        currentAttemptId: typeof row.current_attempt_id === 'string' ? row.current_attempt_id : null,
      };
    });
  }

  async listTaskFollowUps(input: {
    taskId: string;
    ownerUserId: string;
  }): Promise<TaskFollowUpMessageV1[]> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        `SELECT message.id, message.sender_type, message.content, message.created_at
         FROM messages AS message
         JOIN control_tasks AS task ON task.conversation_id = message.conversation_id
         JOIN conversations AS conversation ON conversation.id = task.conversation_id
         WHERE task.id = $1
           AND task.owner_user_id = $2
           AND conversation.owner_user_id = $2
           AND message.content->>'version' = 'task-follow-up-message-v1'
           AND message.content->>'taskId' = $1::text
         ORDER BY message.created_at ASC,
                  CASE message.sender_type WHEN 'user' THEN 0 ELSE 1 END ASC,
                  message.id ASC`,
        [input.taskId, input.ownerUserId],
      );
      return result.rows.map(taskFollowUpMessageFromRow);
    } finally {
      connection.release();
    }
  }

  async getCommand(taskId: string, commandType: string, idempotencyKey: string): Promise<ControlCommandRecord | null> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        `SELECT request_hash, response_json FROM control_commands
         WHERE task_id = $1 AND command_type = $2 AND idempotency_key = $3`,
        [taskId, commandType, idempotencyKey],
      );
      const row = result.rows[0];
      return row ? { requestHash: asString(row.request_hash, 'request_hash'), response: row.response_json } : null;
    } finally {
      connection.release();
    }
  }

  async reserveFollowUpCommand(input: {
    taskId: string;
    idempotencyKey: string;
    requestHash: string;
    expectedVersion: number;
    actorUserId: string;
  }): Promise<ControlCommandReservation> {
    return this.transaction(async (connection) => {
      const taskResult = await connection.query(
        `SELECT task.state, task.state_version, task.owner_user_id,
                conversation.owner_user_id AS conversation_owner_user_id
         FROM control_tasks AS task
         JOIN conversations AS conversation ON conversation.id = task.conversation_id
         WHERE task.id = $1
         FOR UPDATE OF task`,
        [input.taskId],
      );
      const task = taskResult.rows[0];
      if (!task) throw new ControlPlaneConflictError(`task ${input.taskId} does not exist`);
      if (
        task.owner_user_id !== input.actorUserId
        || task.conversation_owner_user_id !== input.actorUserId
      ) throw new ControlPlaneAuthorizationError(`actor cannot control task ${input.taskId}`);

      const existingResult = await connection.query(
        `SELECT request_hash, command_status, response_json, reservation_expires_at
         FROM control_commands
         WHERE task_id = $1 AND command_type = 'report_follow_up' AND idempotency_key = $2
         FOR UPDATE`,
        [input.taskId, input.idempotencyKey],
      );
      const existing = existingResult.rows[0];
      if (existing) {
        if (existing.request_hash !== input.requestHash) return { status: 'conflict' };
        if (existing.command_status === 'completed') {
          return { status: 'replay', response: existing.response_json };
        }
        const expiresAt = asDate(existing.reservation_expires_at, 'reservation_expires_at');
        if (expiresAt.getTime() > Date.now()) return { status: 'pending' };
      }

      const state = asString(task.state, 'state') as ControlTaskState;
      const stateVersion = asNumber(task.state_version, 'state_version');
      if (
        (state !== 'completed' && state !== 'completed_with_gaps')
        || stateVersion !== input.expectedVersion
      ) {
        throw new ControlPlaneConflictError(`task ${input.taskId} has no completed report at version ${input.expectedVersion}`);
      }
      const reservationToken = randomUUID();
      const reservationExpiresAt = new Date(Date.now() + 5 * 60_000);
      if (existing) {
        await connection.query(
          `UPDATE control_commands
           SET expected_version = $3, state_before = $4, state_after = $4,
               actor_user_id = $5, reservation_token = $6, reservation_expires_at = $7
           WHERE task_id = $1 AND idempotency_key = $2
             AND command_type = 'report_follow_up' AND command_status = 'pending'`,
          [
            input.taskId, input.idempotencyKey, input.expectedVersion, state,
            input.actorUserId, reservationToken, reservationExpiresAt,
          ],
        );
      } else {
        await connection.query(
          `INSERT INTO control_commands
             (task_id, command_type, idempotency_key, request_hash, expected_version,
              state_before, state_after, response_json, actor_user_id, command_status,
              reservation_token, reservation_expires_at)
           VALUES ($1, 'report_follow_up', $2, $3, $4, $5, $5, NULL, $6, 'pending', $7, $8)`,
          [
            input.taskId, input.idempotencyKey, input.requestHash, input.expectedVersion,
            state, input.actorUserId, reservationToken, reservationExpiresAt,
          ],
        );
      }
      return { status: 'reserved', reservationToken };
    });
  }

  async reserveCommand(input: {
    taskId: string;
    commandType: string;
    idempotencyKey: string;
    requestHash: string;
    expectedVersion: number;
    actorUserId?: string;
  }): Promise<ControlCommandReservation> {
    return this.transaction(async (connection) => {
      const taskResult = await connection.query(
        `SELECT task.state, task.state_version, task.owner_user_id,
                conversation.owner_user_id AS conversation_owner_user_id
         FROM control_tasks AS task
         JOIN conversations AS conversation ON conversation.id = task.conversation_id
         WHERE task.id = $1
         FOR UPDATE OF task`,
        [input.taskId],
      );
      const task = taskResult.rows[0];
      if (!task) throw new ControlPlaneConflictError(`task ${input.taskId} does not exist`);
      if (
        input.actorUserId
        && (task.owner_user_id !== input.actorUserId
          || task.conversation_owner_user_id !== input.actorUserId)
      ) {
        throw new ControlPlaneAuthorizationError(`actor cannot control task ${input.taskId}`);
      }

      const existingResult = await connection.query(
        `SELECT request_hash, command_status, response_json, reservation_expires_at
         FROM control_commands
         WHERE task_id = $1 AND command_type = $2 AND idempotency_key = $3
         FOR UPDATE`,
        [input.taskId, input.commandType, input.idempotencyKey],
      );
      const existing = existingResult.rows[0];
      if (existing) {
        if (existing.request_hash !== input.requestHash) return { status: 'conflict' };
        if (existing.command_status === 'completed') {
          return { status: 'replay', response: existing.response_json };
        }
        const expiresAt = asDate(existing.reservation_expires_at, 'reservation_expires_at');
        if (expiresAt.getTime() > Date.now()) return { status: 'pending' };
      }

      const taskStateVersion = asNumber(task.state_version, 'state_version');
      const resumesActivatedRequirement = Boolean(existing)
        && taskStateVersion === input.expectedVersion + 1;
      if (task.state !== 'awaiting_clarification') {
        throw new ControlPlaneConflictError(`task ${input.taskId} is not awaiting_clarification`);
      }
      if (taskStateVersion !== input.expectedVersion && !resumesActivatedRequirement) {
        throw new ControlPlaneConflictError(`task ${input.taskId} is not at version ${input.expectedVersion}`);
      }

      const reservationToken = randomUUID();
      const reservationExpiresAt = new Date(Date.now() + 5 * 60_000);
      if (existing) {
        await connection.query(
          `UPDATE control_commands
           SET expected_version = $4,
               state_before = 'awaiting_clarification',
               state_after = 'awaiting_clarification',
               actor_user_id = $5,
               reservation_token = $6,
               reservation_expires_at = $7
           WHERE task_id = $1 AND command_type = $2 AND idempotency_key = $3
             AND command_status = 'pending'`,
          [
            input.taskId,
            input.commandType,
            input.idempotencyKey,
            input.expectedVersion,
            input.actorUserId ?? null,
            reservationToken,
            reservationExpiresAt,
          ],
        );
      } else {
        await connection.query(
          `INSERT INTO control_commands
             (task_id, command_type, idempotency_key, request_hash, expected_version,
              state_before, state_after, response_json, actor_user_id, command_status,
              reservation_token, reservation_expires_at)
           VALUES ($1, $2, $3, $4, $5, 'awaiting_clarification',
                   'awaiting_clarification', NULL, $6, 'pending', $7, $8)`,
          [
            input.taskId,
            input.commandType,
            input.idempotencyKey,
            input.requestHash,
            input.expectedVersion,
            input.actorUserId ?? null,
            reservationToken,
            reservationExpiresAt,
          ],
        );
      }
      return { status: 'reserved', reservationToken };
    });
  }

  async reserveDatasetUploadCommand(input: {
    taskId: string;
    planVersionId: string;
    idempotencyKey: string;
    requestHash: string;
    expectedVersion: number;
    actorUserId: string;
    commandType: string;
  }): Promise<ControlCommandReservation> {
    return this.transaction(async (connection) => {
      const taskResult = await connection.query(
        `SELECT task.state, task.state_version, task.active_plan_version_id,
                task.owner_user_id,
                (SELECT owner_user_id FROM conversations
                 WHERE id = task.conversation_id) AS conversation_owner_user_id
         FROM control_tasks AS task
         WHERE task.id = $1
         FOR UPDATE`,
        [input.taskId],
      );
      const task = taskResult.rows[0];
      if (!task) throw new ControlPlaneConflictError(`task ${input.taskId} does not exist`);
      if (
        task.owner_user_id !== input.actorUserId
        || task.conversation_owner_user_id !== input.actorUserId
      ) throw new ControlPlaneAuthorizationError(`actor cannot control task ${input.taskId}`);

      const existingResult = await connection.query(
        `SELECT request_hash, command_status, response_json, reservation_expires_at
         FROM control_commands
         WHERE task_id = $1 AND command_type = $2 AND idempotency_key = $3
         FOR UPDATE`,
        [input.taskId, input.commandType, input.idempotencyKey],
      );
      const existing = existingResult.rows[0];
      if (existing) {
        if (existing.request_hash !== input.requestHash) return { status: 'conflict' };
        if (existing.command_status === 'completed') {
          return { status: 'replay', response: existing.response_json };
        }
        const expiresAt = asDate(existing.reservation_expires_at, 'reservation_expires_at');
        if (expiresAt.getTime() > Date.now()) return { status: 'pending' };
      }

      if (
        task.state !== 'awaiting_confirmation'
        || asNumber(task.state_version, 'state_version') !== input.expectedVersion
        || task.active_plan_version_id !== input.planVersionId
      ) {
        throw new ControlPlaneConflictError(
          `task ${input.taskId} is not awaiting_confirmation at version ${input.expectedVersion}`,
        );
      }
      const reservationToken = randomUUID();
      const reservationExpiresAt = new Date(Date.now() + 5 * 60_000);
      if (existing) {
        await connection.query(
          `UPDATE control_commands
           SET expected_version = $4,
               state_before = 'awaiting_confirmation',
               state_after = 'awaiting_confirmation',
               actor_user_id = $5,
               reservation_token = $6,
               reservation_expires_at = $7
           WHERE task_id = $1 AND command_type = $2 AND idempotency_key = $3
             AND command_status = 'pending'`,
          [
            input.taskId, input.commandType, input.idempotencyKey, input.expectedVersion,
            input.actorUserId, reservationToken, reservationExpiresAt,
          ],
        );
      } else {
        await connection.query(
          `INSERT INTO control_commands
             (task_id, command_type, idempotency_key, request_hash, expected_version,
              state_before, state_after, response_json, actor_user_id, command_status,
              reservation_token, reservation_expires_at)
           VALUES ($1, $2, $3, $4, $5, 'awaiting_confirmation',
                   'awaiting_confirmation', NULL, $6, 'pending', $7, $8)`,
          [
            input.taskId, input.commandType, input.idempotencyKey, input.requestHash,
            input.expectedVersion, input.actorUserId, reservationToken, reservationExpiresAt,
          ],
        );
      }
      return { status: 'reserved', reservationToken };
    });
  }

  async completeDatasetUploadCommand(input: {
    taskId: string;
    planVersionId: string;
    commandType: string;
    idempotencyKey: string;
    requestHash: string;
    expectedVersion: number;
    reservationToken: string;
    response: unknown;
  }): Promise<void> {
    await this.transaction(async (connection) => {
      const task = (await connection.query(
        `SELECT state, state_version, active_plan_version_id
         FROM control_tasks WHERE id = $1 FOR UPDATE`,
        [input.taskId],
      )).rows[0];
      if (
        !task
        || task.state !== 'awaiting_confirmation'
        || asNumber(task.state_version, 'state_version') !== input.expectedVersion
        || task.active_plan_version_id !== input.planVersionId
      ) throw new ControlPlaneConflictError('dataset upload lost the active Plan binding');
      const completed = await connection.query(
        `UPDATE control_commands
         SET response_json = $7, command_status = 'completed',
             reservation_token = NULL, reservation_expires_at = NULL
         WHERE task_id = $1 AND command_type = $2 AND idempotency_key = $3
           AND request_hash = $4 AND expected_version = $5
           AND command_status = 'pending' AND reservation_token = $6
         RETURNING id`,
        [
          input.taskId, input.commandType, input.idempotencyKey, input.requestHash,
          input.expectedVersion, input.reservationToken, JSON.stringify(input.response),
        ],
      );
      if (!completed.rows[0]) throw new ControlPlaneConflictError('dataset upload reservation fence was lost');
    });
  }

  async reserveConfirmationCommand(input: {
    taskId: string;
    planVersionId: string;
    idempotencyKey: string;
    requestHash: string;
    expectedVersion: number;
    actorUserId: string;
  }): Promise<ControlCommandReservation> {
    return this.transaction(async (connection) => {
      const taskResult = await connection.query(
        `SELECT task.state, task.state_version, task.active_plan_version_id,
                task.owner_user_id,
                (SELECT owner_user_id FROM conversations
                 WHERE id = task.conversation_id) AS conversation_owner_user_id
         FROM control_tasks AS task
         WHERE task.id = $1
         FOR UPDATE`,
        [input.taskId],
      );
      const task = taskResult.rows[0];
      if (!task) throw new ControlPlaneConflictError(`task ${input.taskId} does not exist`);
      if (
        task.owner_user_id !== input.actorUserId
        || task.conversation_owner_user_id !== input.actorUserId
      ) {
        throw new ControlPlaneAuthorizationError(`actor cannot control task ${input.taskId}`);
      }

      const existingResult = await connection.query(
        `SELECT request_hash, command_status, response_json, reservation_expires_at
         FROM control_commands
         WHERE task_id = $1 AND command_type = 'confirmation' AND idempotency_key = $2
         FOR UPDATE`,
        [input.taskId, input.idempotencyKey],
      );
      const existing = existingResult.rows[0];
      if (existing) {
        if (existing.request_hash !== input.requestHash) return { status: 'conflict' };
        if (existing.command_status === 'completed') {
          return { status: 'replay', response: existing.response_json };
        }
        const expiresAt = asDate(existing.reservation_expires_at, 'reservation_expires_at');
        if (expiresAt.getTime() > Date.now()) return { status: 'pending' };
      }

      if (
        task.state !== 'awaiting_confirmation'
        || asNumber(task.state_version, 'state_version') !== input.expectedVersion
        || task.active_plan_version_id !== input.planVersionId
      ) {
        throw new ControlPlaneConflictError(
          `task ${input.taskId} is not awaiting_confirmation at version ${input.expectedVersion}`,
        );
      }
      const competing = await connection.query(
        `SELECT 1
         FROM control_commands
         WHERE task_id = $1 AND command_type = 'confirmation'
           AND command_status = 'pending' AND idempotency_key <> $2
           AND reservation_expires_at > now()
         LIMIT 1`,
        [input.taskId, input.idempotencyKey],
      );
      if (competing.rows[0]) return { status: 'conflict' };
      await connection.query(
        `DELETE FROM control_commands
         WHERE task_id = $1 AND command_type = 'confirmation'
           AND command_status = 'pending' AND idempotency_key <> $2
           AND reservation_expires_at <= now()`,
        [input.taskId, input.idempotencyKey],
      );

      const reservationToken = randomUUID();
      const reservationExpiresAt = new Date(Date.now() + 5 * 60_000);
      if (existing) {
        await connection.query(
          `UPDATE control_commands
           SET expected_version = $3,
               state_before = 'awaiting_confirmation',
               state_after = 'awaiting_confirmation',
               actor_user_id = $4,
               reservation_token = $5,
               reservation_expires_at = $6
           WHERE task_id = $1 AND command_type = 'confirmation' AND idempotency_key = $2
             AND command_status = 'pending'`,
          [
            input.taskId,
            input.idempotencyKey,
            input.expectedVersion,
            input.actorUserId,
            reservationToken,
            reservationExpiresAt,
          ],
        );
      } else {
        await connection.query(
          `INSERT INTO control_commands
             (task_id, command_type, idempotency_key, request_hash, expected_version,
              state_before, state_after, response_json, actor_user_id, command_status,
              reservation_token, reservation_expires_at)
           VALUES ($1, 'confirmation', $2, $3, $4, 'awaiting_confirmation',
                   'awaiting_confirmation', NULL, $5, 'pending', $6, $7)`,
          [
            input.taskId,
            input.idempotencyKey,
            input.requestHash,
            input.expectedVersion,
            input.actorUserId,
            reservationToken,
            reservationExpiresAt,
          ],
        );
      }
      return { status: 'reserved', reservationToken };
    });
  }

  async beginVisualPublication(input: {
    taskId: string;
    planVersionId: string;
    idempotencyKey: string;
    requestHash: string;
    expectedVersion: number;
    reservationToken: string;
  }): Promise<string> {
    return this.transaction(async (connection) => {
      const taskResult = await connection.query(
        `SELECT state, state_version, active_plan_version_id
         FROM control_tasks
         WHERE id = $1
         FOR UPDATE`,
        [input.taskId],
      );
      const task = taskResult.rows[0];
      if (
        !task
        || task.state !== 'awaiting_confirmation'
        || asNumber(task.state_version, 'state_version') !== input.expectedVersion
        || task.active_plan_version_id !== input.planVersionId
      ) {
        throw new ControlPlaneConflictError('confirmation task cannot begin a visual publication');
      }
      const command = await connection.query(
        `SELECT id
         FROM control_commands
         WHERE task_id = $1
           AND command_type = 'confirmation'
           AND idempotency_key = $2
           AND request_hash = $3
           AND expected_version = $4
           AND command_status = 'pending'
           AND reservation_token = $5
           AND reservation_expires_at > now()
         FOR UPDATE`,
        [
          input.taskId,
          input.idempotencyKey,
          input.requestHash,
          input.expectedVersion,
          input.reservationToken,
        ],
      );
      const commandId = command.rows[0]?.id;
      if (typeof commandId !== 'string') {
        throw new ControlPlaneConflictError('confirmation command cannot begin a visual publication');
      }
      const reservationTokenHash = hashLeaseToken(input.reservationToken);
      const inserted = await connection.query(
        `INSERT INTO control_visual_publications
           (task_id, plan_version_id, command_id, request_hash, expected_version,
            reservation_token_hash, state)
         VALUES ($1, $2, $3, $4, $5, $6, 'PUBLISHING')
         ON CONFLICT (command_id, reservation_token_hash) DO NOTHING
         RETURNING id`,
        [
          input.taskId,
          input.planVersionId,
          commandId,
          input.requestHash,
          input.expectedVersion,
          reservationTokenHash,
        ],
      );
      if (typeof inserted.rows[0]?.id === 'string') return inserted.rows[0].id;
      const existing = await connection.query(
        `SELECT id, state FROM control_visual_publications
         WHERE command_id = $1 AND reservation_token_hash = $2
         FOR UPDATE`,
        [commandId, reservationTokenHash],
      );
      if (existing.rows[0]?.state !== 'PUBLISHING' || typeof existing.rows[0]?.id !== 'string') {
        throw new ControlPlaneConflictError('confirmation visual publication is already terminal');
      }
      return existing.rows[0].id;
    });
  }

  async completeConfirmationCommand(input: {
    taskId: string;
    planVersionId: string;
    planHash: string;
    idempotencyKey: string;
    requestHash: string;
    expectedVersion: number;
    reservationToken: string;
    publicationId?: string;
    actorUserId: string;
    actorService?: string;
    actorRole: string;
    nextState: 'awaiting_approval' | 'ready';
    gates: Array<{
      gateType: 'confirmation' | 'input';
      gateKey: string;
      requiredAuthority: string;
      decision: string;
      value?: unknown;
      evidenceRef?: string | null;
      evidenceKind?: 'visual' | 'dataset' | 'document';
      idempotencyKey: string;
    }>;
  }): Promise<ControlTask> {
    const seenGates = new Set<string>();
    const gates = input.gates.map((gate) => {
      const key = `${gate.gateType}\u0000${gate.gateKey}`;
      if (seenGates.has(key)) throw new ControlPlaneConflictError(`duplicate confirmation gate ${gate.gateKey}`);
      seenGates.add(key);
      if (gate.evidenceRef && gate.value !== undefined && gate.value !== null) {
        throw new ControlPlaneConflictError(`gate ${gate.gateKey} has both a value and evidence reference`);
      }
      return { ...gate, serializedValue: serializedGateValue(gate.value) };
    });
    const evidenceRefs = gates
      .map((gate) => gate.evidenceRef)
      .filter((reference): reference is string => typeof reference === 'string');
    const visualEvidenceRefs = gates
      .filter((gate) => gate.evidenceRef && (gate.evidenceKind ?? 'visual') === 'visual')
      .map((gate) => gate.evidenceRef as string);
    if (new Set(evidenceRefs).size !== evidenceRefs.length) {
      throw new ControlPlaneConflictError('confirmation evidence references must be unique');
    }
    if (input.publicationId !== undefined && visualEvidenceRefs.length === 0) {
      throw new ControlPlaneConflictError('confirmation visual publication has no visual evidence');
    }

    return this.transaction(async (connection) => {
      const taskResult = await connection.query(
        `SELECT task.state, task.state_version, task.active_plan_version_id,
                task.owner_user_id,
                (SELECT owner_user_id FROM conversations
                 WHERE id = task.conversation_id) AS conversation_owner_user_id
         FROM control_tasks AS task
         WHERE task.id = $1
         FOR UPDATE`,
        [input.taskId],
      );
      const task = taskResult.rows[0];
      if (
        !task
        || task.state !== 'awaiting_confirmation'
        || asNumber(task.state_version, 'state_version') !== input.expectedVersion
        || task.active_plan_version_id !== input.planVersionId
      ) {
        throw new ControlPlaneConflictError(
          `task ${input.taskId} lost confirmation fence at version ${input.expectedVersion}`,
        );
      }
      if (
        task.owner_user_id !== input.actorUserId
        || task.conversation_owner_user_id !== input.actorUserId
      ) {
        throw new ControlPlaneAuthorizationError(`actor cannot control task ${input.taskId}`);
      }
      const planResult = await connection.query(
        `SELECT 1 FROM control_plan_versions
         WHERE id = $1 AND task_id = $2 AND plan_hash = $3`,
        [input.planVersionId, input.taskId, input.planHash],
      );
      if (!planResult.rows[0]) throw new ControlPlaneConflictError('active confirmation plan hash does not match');
      const commandResult = await connection.query(
        `SELECT id FROM control_commands
         WHERE task_id = $1 AND command_type = 'confirmation' AND idempotency_key = $2
           AND request_hash = $3 AND expected_version = $4
           AND command_status = 'pending' AND reservation_token = $5
           AND reservation_expires_at > now()
         FOR UPDATE`,
        [
          input.taskId,
          input.idempotencyKey,
          input.requestHash,
          input.expectedVersion,
          input.reservationToken,
        ],
      );
      if (!commandResult.rows[0]) throw new ControlPlaneConflictError('confirmation command reservation fence was lost');

      if (input.publicationId) {
        const publication = await connection.query(
          `SELECT 1 FROM control_visual_publications
           WHERE id = $1
             AND task_id = $2
             AND plan_version_id = $3
             AND command_id = $7
             AND request_hash = $4
             AND expected_version = $5
             AND reservation_token_hash = $6
             AND state = 'PUBLISHING'
           FOR UPDATE`,
          [
            input.publicationId,
            input.taskId,
            input.planVersionId,
            input.requestHash,
            input.expectedVersion,
            hashLeaseToken(input.reservationToken),
            commandResult.rows[0].id,
          ],
        );
        if (!publication.rows[0]) {
          throw new ControlPlaneConflictError('confirmation visual publication fence was lost');
        }
        const members = await connection.query(
          `SELECT id, kind, state FROM control_artifacts
           WHERE publication_id = $1
           FOR UPDATE`,
          [input.publicationId],
        );
        if (members.rows.length === 0 || members.rows.some((artifact) => artifact.state !== 'SEALED')) {
          throw new ControlPlaneConflictError('confirmation visual publication has an unsealed Artifact');
        }
        const gateArtifactIds = members.rows
          .filter((artifact) => artifact.kind === 'visual_input_gate')
          .map((artifact) => asString(artifact.id, 'id'))
          .sort();
        const sortedEvidenceRefs = [...visualEvidenceRefs].sort();
        if (
          gateArtifactIds.length !== sortedEvidenceRefs.length
          || gateArtifactIds.some((artifactId, index) => artifactId !== sortedEvidenceRefs[index])
        ) {
          throw new ControlPlaneConflictError('confirmation evidence references do not exactly match its visual publication');
        }
      }

      const existingGates = await connection.query(
        `SELECT 1 FROM control_gate_records
         WHERE task_id = $1 AND plan_version_id = $2
         LIMIT 1`,
        [input.taskId, input.planVersionId],
      );
      if (existingGates.rows[0]) {
        throw new ControlPlaneConflictError('active confirmation plan already has a gate record');
      }

      for (const gate of gates) {
        if (gate.evidenceRef) {
          const evidenceKind = gate.evidenceKind ?? 'visual';
          const expectedKind = evidenceKind === 'dataset'
            ? 'dataset_input_profile'
            : evidenceKind === 'document'
              ? 'document_input_manifest'
              : 'visual_input_gate';
          const expectedSchema = evidenceKind === 'dataset'
            ? 'dataset-input-profile-v1'
            : evidenceKind === 'document'
              ? 'document-input-manifest-v1'
              : 'visual-input-gate-v1';
          const artifact = await connection.query(
            `SELECT 1 FROM control_artifacts
             WHERE id = $1 AND task_id = $2 AND plan_version_id = $3
               AND attempt_id IS NULL AND state = 'SEALED'
               AND kind = $4 AND schema_version = $5
               AND ($6::text NOT IN ('dataset', 'document') OR metadata_json->>'role' = $7)`,
            [
              gate.evidenceRef,
              input.taskId,
              input.planVersionId,
              expectedKind,
              expectedSchema,
              evidenceKind,
              gate.gateKey,
            ],
          );
          if (!artifact.rows[0]) {
            throw new ControlPlaneConflictError(`gate ${gate.gateKey} evidence reference is not sealed and plan-bound`);
          }
        }
        await connection.query(
          `INSERT INTO control_gate_records
             (task_id, plan_version_id, plan_hash, gate_type, gate_key, required_authority,
              decision, value_json, evidence_ref, actor_user_id, actor_service, actor_role,
              policy_version, idempotency_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'trusted-p0-v1', $13)`,
          [
            input.taskId,
            input.planVersionId,
            input.planHash,
            gate.gateType,
            gate.gateKey,
            gate.requiredAuthority,
            gate.decision,
            gate.serializedValue,
            gate.evidenceRef ?? null,
            input.actorUserId,
            input.actorService ?? null,
            input.actorRole,
            gate.idempotencyKey,
          ],
        );
      }

      const updated = await connection.query(
        `UPDATE control_tasks
         SET state = $3, state_version = state_version + 1, updated_at = now()
         WHERE id = $1 AND state_version = $2 AND state = 'awaiting_confirmation'
           AND active_plan_version_id = $4
         RETURNING id, state, state_version, active_plan_version_id, current_attempt_id`,
        [input.taskId, input.expectedVersion, input.nextState, input.planVersionId],
      );
      const row = updated.rows[0];
      if (!row) throw new ControlPlaneConflictError(`task ${input.taskId} lost confirmation CAS`);
      if (input.publicationId) {
        const committedPublication = await connection.query(
          `UPDATE control_visual_publications
           SET state = 'COMMITTED', evidence_refs = $2, committed_at = now()
           WHERE id = $1 AND state = 'PUBLISHING'
           RETURNING id`,
          [input.publicationId, JSON.stringify(evidenceRefs)],
        );
        if (!committedPublication.rows[0]) {
          throw new ControlPlaneConflictError('confirmation visual publication commit fence was lost');
        }
      }
      const response = {
        state: asString(row.state, 'state') as ControlTaskState,
        stateVersion: asNumber(row.state_version, 'state_version'),
      };
      const completed = await connection.query(
        `UPDATE control_commands
         SET state_after = $6,
             response_json = $7,
             command_status = 'completed',
             reservation_token = NULL,
             reservation_expires_at = NULL
         WHERE task_id = $1 AND command_type = 'confirmation' AND idempotency_key = $2
           AND request_hash = $3 AND expected_version = $4
           AND command_status = 'pending' AND reservation_token = $5
         RETURNING id`,
        [
          input.taskId,
          input.idempotencyKey,
          input.requestHash,
          input.expectedVersion,
          input.reservationToken,
          response.state,
          JSON.stringify(response),
        ],
      );
      if (!completed.rows[0]) throw new ControlPlaneConflictError('confirmation command completion fence was lost');
      return {
        id: asString(row.id, 'id'),
        state: response.state,
        stateVersion: response.stateVersion,
        activePlanVersionId: typeof row.active_plan_version_id === 'string' ? row.active_plan_version_id : null,
        currentAttemptId: typeof row.current_attempt_id === 'string' ? row.current_attempt_id : null,
      };
    });
  }

  async completeFollowUpCommand(input: {
    taskId: string;
    conversationId: string;
    idempotencyKey: string;
    requestHash: string;
    expectedVersion: number;
    reservationToken: string;
    state: 'completed' | 'completed_with_gaps';
    finalReportArtifactId: string;
    response: TaskFollowUpResponse;
  }): Promise<void> {
    await this.transaction(async (connection) => {
      const task = (await connection.query(
        `SELECT state, state_version, conversation_id
         FROM control_tasks WHERE id = $1 FOR UPDATE`,
        [input.taskId],
      )).rows[0];
      if (
        !task
        || task.state !== input.state
        || asNumber(task.state_version, 'state_version') !== input.expectedVersion
        || task.conversation_id !== input.conversationId
      ) throw new ControlPlaneConflictError('report follow-up lost the completed Task binding');

      const [userMessage, assistantMessage] = input.response.messages;
      if (!userMessage || !assistantMessage) {
        throw new ControlPlaneConflictError('report follow-up response is incomplete');
      }
      const inserted = await connection.query(
        `INSERT INTO messages
           (id, conversation_id, sender_type, message_type, content, artifact_id, idempotency_key, created_at)
         VALUES
           ($1, $3, 'user', 'text', $5, NULL, $7, $9),
           ($2, $3, 'assistant', 'report', $6, $4, $8, $10)
         ON CONFLICT (conversation_id, idempotency_key)
           WHERE idempotency_key IS NOT NULL
         DO NOTHING
         RETURNING id`,
        [
          userMessage.id,
          assistantMessage.id,
          input.conversationId,
          input.finalReportArtifactId,
          JSON.stringify(userMessage),
          JSON.stringify(assistantMessage),
          `follow-up:${input.idempotencyKey}:user`,
          `follow-up:${input.idempotencyKey}:assistant`,
          new Date(userMessage.createdAt),
          new Date(assistantMessage.createdAt),
        ],
      );
      if (inserted.rows.length !== 2) {
        throw new ControlPlaneConflictError('report follow-up messages were not committed together');
      }
      const completed = await connection.query(
        `UPDATE control_commands
         SET state_after = $6, response_json = $7, command_status = 'completed',
             reservation_token = NULL, reservation_expires_at = NULL
         WHERE task_id = $1 AND command_type = 'report_follow_up' AND idempotency_key = $2
           AND request_hash = $3 AND expected_version = $4
           AND command_status = 'pending' AND reservation_token = $5
         RETURNING id`,
        [
          input.taskId,
          input.idempotencyKey,
          input.requestHash,
          input.expectedVersion,
          input.reservationToken,
          input.state,
          JSON.stringify(input.response),
        ],
      );
      if (!completed.rows[0]) {
        throw new ControlPlaneConflictError('report follow-up command reservation fence was lost');
      }
      await connection.query(
        `UPDATE conversations SET last_message_at = $2, updated_at = $2 WHERE id = $1`,
        [input.conversationId, new Date(assistantMessage.createdAt)],
      );
    });
  }

  async completeCommand(input: {
    taskId: string;
    commandType: string;
    idempotencyKey: string;
    requestHash: string;
    expectedVersion: number;
    reservationToken: string;
    stateAfter: ControlTaskState;
    response: unknown;
  }): Promise<void> {
    await this.transaction(async (connection) => {
      const result = await connection.query(
        `UPDATE control_commands
         SET state_after = $7,
             response_json = $8,
             command_status = 'completed',
             reservation_token = NULL,
             reservation_expires_at = NULL
         WHERE task_id = $1 AND command_type = $2 AND idempotency_key = $3
           AND request_hash = $4 AND expected_version = $5
           AND command_status = 'pending' AND reservation_token = $6
         RETURNING id`,
        [
          input.taskId,
          input.commandType,
          input.idempotencyKey,
          input.requestHash,
          input.expectedVersion,
          input.reservationToken,
          input.stateAfter,
          JSON.stringify(input.response),
        ],
      );
      if (!result.rows[0]) {
        throw new ControlPlaneConflictError('clarification command reservation fence was lost');
      }
    });
  }

  async releaseCommand(input: {
    taskId: string;
    commandType: string;
    idempotencyKey: string;
    requestHash: string;
    expectedVersion: number;
    reservationToken: string;
  }): Promise<boolean> {
    return this.transaction(async (connection) => {
      const released = await connection.query(
        `DELETE FROM control_commands
         WHERE task_id = $1 AND command_type = $2 AND idempotency_key = $3
           AND request_hash = $4 AND expected_version = $5
           AND command_status = 'pending' AND reservation_token = $6
         RETURNING id`,
        [
          input.taskId,
          input.commandType,
          input.idempotencyKey,
          input.requestHash,
          input.expectedVersion,
          input.reservationToken,
        ],
      );
      return Boolean(released.rows[0]);
    });
  }

  async settleVisualPublicationAfterFailure(input: {
    publicationId: string;
    taskId: string;
    planVersionId: string;
    idempotencyKey: string;
    requestHash: string;
    expectedVersion: number;
    reservationToken: string;
    releaseReservation: boolean;
    reason: string;
  }): Promise<'live' | 'committed' | 'abandoned'> {
    return this.transaction(async (connection) => {
      const taskResult = await connection.query(
        `SELECT state, state_version, active_plan_version_id
         FROM control_tasks
         WHERE id = $1
         FOR UPDATE`,
        [input.taskId],
      );
      const task = taskResult.rows[0];
      if (!task) throw new ControlPlaneConflictError(`task ${input.taskId} does not exist`);
      const fence = await connection.query(
        `SELECT id, command_status, request_hash, expected_version,
                reservation_token, reservation_expires_at
         FROM control_commands
         WHERE task_id = $1
           AND command_type = 'confirmation'
           AND idempotency_key = $2
         FOR UPDATE`,
        [input.taskId, input.idempotencyKey],
      );
      const command = fence.rows[0];
      const publicationResult = await connection.query(
        `SELECT publication.state, publication.command_id
         FROM control_visual_publications AS publication
         WHERE publication.id = $1
           AND publication.task_id = $2
           AND publication.plan_version_id = $3
           AND publication.request_hash = $4
           AND publication.expected_version = $5
           AND publication.reservation_token_hash = $6
         FOR UPDATE`,
        [
          input.publicationId,
          input.taskId,
          input.planVersionId,
          input.requestHash,
          input.expectedVersion,
          hashLeaseToken(input.reservationToken),
        ],
      );
      const publication = publicationResult.rows[0];
      if (!publication) throw new ControlPlaneConflictError('visual publication does not match its confirmation reservation');
      if (publication.state === 'COMMITTED') return 'committed';
      if (publication.state === 'ABANDONED') return 'abandoned';
      const exactReservation = Boolean(command)
        && command.id === publication.command_id
        && command.command_status === 'pending'
        && command.request_hash === input.requestHash
        && asNumber(command.expected_version, 'expected_version') === input.expectedVersion
        && command.reservation_token === input.reservationToken;
      const canCommit = exactReservation
        && asDate(command.reservation_expires_at, 'reservation_expires_at').getTime() > Date.now()
        && task.state === 'awaiting_confirmation'
        && asNumber(task.state_version, 'state_version') === input.expectedVersion
        && task.active_plan_version_id === input.planVersionId;
      if (canCommit && !input.releaseReservation) return 'live';

      if (input.releaseReservation && exactReservation) {
        await connection.query(
          `DELETE FROM control_commands
           WHERE id = $1 AND command_status = 'pending' AND reservation_token = $2`,
          [publication.command_id, input.reservationToken],
        );
      }
      await connection.query(
        `UPDATE control_artifacts
         SET state = 'FAILED', failure_reason = $2, redaction_status = 'failed'
         WHERE publication_id = $1 AND state IN ('STAGING', 'SEALED')`,
        [input.publicationId, input.reason],
      );
      const abandoned = await connection.query(
        `UPDATE control_visual_publications
         SET state = 'ABANDONED', failure_reason = $2, abandoned_at = now()
         WHERE id = $1 AND state = 'PUBLISHING'
         RETURNING id`,
        [input.publicationId, input.reason],
      );
      if (!abandoned.rows[0]) throw new ControlPlaneConflictError('visual publication abandonment fence was lost');
      return 'abandoned';
    });
  }

  async recoverVisualPublications(): Promise<number> {
    return this.transaction(async (connection) => {
      const snapshot = await connection.query(
        `SELECT id, task_id, command_id
         FROM control_visual_publications
         WHERE state = 'PUBLISHING'`,
      );
      if (snapshot.rows.length === 0) return 0;
      const taskIds = [...new Set(snapshot.rows.map((row) => asString(row.task_id, 'task_id')))].sort();
      const commandIds = [...new Set(snapshot.rows.map((row) => asString(row.command_id, 'command_id')))].sort();
      const publicationIds = snapshot.rows.map((row) => asString(row.id, 'id')).sort();
      await connection.query(
        `SELECT id FROM control_tasks
         WHERE id = ANY($1::uuid[])
         ORDER BY id
         FOR UPDATE`,
        [taskIds],
      );
      await connection.query(
        `SELECT id FROM control_commands
         WHERE id = ANY($1::uuid[])
         ORDER BY id
         FOR UPDATE`,
        [commandIds],
      );
      const locked = await connection.query(
        `SELECT id FROM control_visual_publications
         WHERE id = ANY($1::uuid[]) AND state = 'PUBLISHING'
         ORDER BY id
         FOR UPDATE`,
        [publicationIds],
      );
      const lockedPublicationIds = locked.rows.map((row) => asString(row.id, 'id'));
      if (lockedPublicationIds.length === 0) return 0;
      const recoverable = await connection.query(
        `SELECT publication.id
         FROM control_visual_publications AS publication
         LEFT JOIN control_commands AS command ON command.id = publication.command_id
         LEFT JOIN control_tasks AS task ON task.id = publication.task_id
         WHERE publication.id = ANY($1::uuid[])
           AND publication.state = 'PUBLISHING'
           AND NOT COALESCE((
             command.command_status = 'pending'
             AND command.request_hash = publication.request_hash
             AND command.expected_version = publication.expected_version
             AND publication.reservation_token_hash =
                 'sha256:' || encode(digest(command.reservation_token::text, 'sha256'), 'hex')
             AND command.reservation_expires_at > now()
             AND task.state = 'awaiting_confirmation'
             AND task.state_version = publication.expected_version
             AND task.active_plan_version_id = publication.plan_version_id
           ), false)`,
        [lockedPublicationIds],
      );
      const recoverablePublicationIds = recoverable.rows
        .map((row) => row.id)
        .filter((id): id is string => typeof id === 'string');
      if (recoverablePublicationIds.length === 0) return 0;
      const reason = 'confirmation reservation can no longer commit';
      await connection.query(
        `UPDATE control_artifacts
         SET state = 'FAILED', failure_reason = $2, redaction_status = 'failed'
         WHERE publication_id = ANY($1::uuid[]) AND state IN ('STAGING', 'SEALED')`,
        [recoverablePublicationIds, reason],
      );
      const abandoned = await connection.query(
        `UPDATE control_visual_publications
         SET state = 'ABANDONED', failure_reason = $2, abandoned_at = now()
         WHERE id = ANY($1::uuid[]) AND state = 'PUBLISHING'
         RETURNING id`,
        [recoverablePublicationIds, reason],
      );
      return abandoned.rows.length;
    });
  }

  async recoverCommandAfterFailure(input: {
    taskId: string;
    commandType: string;
    idempotencyKey: string;
    requestHash: string;
    expectedVersion: number;
    reservationToken: string;
  }): Promise<void> {
    await this.transaction(async (connection) => {
      const taskResult = await connection.query(
        `SELECT state, state_version
         FROM control_tasks
         WHERE id = $1
         FOR UPDATE`,
        [input.taskId],
      );
      const task = taskResult.rows[0];
      if (!task) return;
      const taskStateVersion = asNumber(task.state_version, 'state_version');
      const commandValues = [
        input.taskId,
        input.commandType,
        input.idempotencyKey,
        input.requestHash,
        input.expectedVersion,
        input.reservationToken,
      ];
      if (taskStateVersion === input.expectedVersion) {
        await connection.query(
          `DELETE FROM control_commands
           WHERE task_id = $1 AND command_type = $2 AND idempotency_key = $3
             AND request_hash = $4 AND expected_version = $5
             AND command_status = 'pending' AND reservation_token = $6`,
          commandValues,
        );
        return;
      }
      if (task.state === 'awaiting_clarification' && taskStateVersion === input.expectedVersion + 1) {
        await connection.query(
          `UPDATE control_commands
           SET reservation_expires_at = now()
           WHERE task_id = $1 AND command_type = $2 AND idempotency_key = $3
             AND request_hash = $4 AND expected_version = $5
             AND command_status = 'pending' AND reservation_token = $6`,
          commandValues,
        );
      }
    });
  }

  async waitForCommand(input: {
    taskId: string;
    commandType: string;
    idempotencyKey: string;
    requestHash: string;
    timeoutMs?: number;
    pollIntervalMs?: number;
  }): Promise<ControlCommandWaitResult> {
    const deadline = Date.now() + (input.timeoutMs ?? 1_000);
    while (true) {
      const connection = await this.database.connect();
      try {
        const result = await connection.query(
          `SELECT request_hash, command_status, response_json
           FROM control_commands
           WHERE task_id = $1 AND command_type = $2 AND idempotency_key = $3`,
          [input.taskId, input.commandType, input.idempotencyKey],
        );
        const command = result.rows[0];
        if (!command) return { status: 'released' };
        if (command.request_hash !== input.requestHash) return { status: 'conflict' };
        if (command.command_status === 'completed') {
          return { status: 'replay', response: command.response_json };
        }
      } finally {
        connection.release();
      }
      if (Date.now() >= deadline) return { status: 'timeout' };
      await delay(input.pollIntervalMs ?? 25);
    }
  }

  async recordCommand(input: {
    taskId: string;
    commandType: string;
    idempotencyKey: string;
    requestHash: string;
    expectedVersion: number;
    stateBefore: ControlTaskState;
    stateAfter: ControlTaskState;
    response: unknown;
    actorUserId?: string;
  }): Promise<void> {
    await this.transaction(async (connection) => {
      await connection.query(
        `INSERT INTO control_commands
         (task_id, command_type, idempotency_key, request_hash, expected_version,
          state_before, state_after, response_json, actor_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          input.taskId, input.commandType, input.idempotencyKey, input.requestHash,
          input.expectedVersion, input.stateBefore, input.stateAfter,
          JSON.stringify(input.response), input.actorUserId ?? null,
        ],
      );
    });
  }

  async recordGate(input: {
    taskId: string;
    planVersionId: string;
    planHash: string;
    gateType: string;
    gateKey: string;
    requiredAuthority: string;
    decision: string;
    value?: unknown;
    evidenceRef?: string | null;
    actorUserId?: string;
    actorService?: string;
    actorRole?: string;
    idempotencyKey: string;
  }): Promise<void> {
    const serializedValue = serializedGateValue(input.value);
    await this.transaction(async (connection) => {
      await connection.query(
        `INSERT INTO control_gate_records
         (task_id, plan_version_id, plan_hash, gate_type, gate_key, required_authority,
          decision, value_json, evidence_ref, actor_user_id, actor_service, actor_role,
          policy_version, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'trusted-p0-v1', $13)`,
        [
          input.taskId, input.planVersionId, input.planHash, input.gateType, input.gateKey,
          input.requiredAuthority, input.decision, serializedValue,
          input.evidenceRef ?? null,
          input.actorUserId ?? null, input.actorService ?? null, input.actorRole ?? null,
          input.idempotencyKey,
        ],
      );
    });
  }

  async listGateRecords(taskId: string, planVersionId: string): Promise<ControlGateRecord[]> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        `SELECT gate_type, gate_key, required_authority, decision, value_json, evidence_ref,
                actor_user_id, actor_role, idempotency_key
         FROM control_gate_records
         WHERE task_id = $1 AND plan_version_id = $2 ORDER BY created_at`,
        [taskId, planVersionId],
      );
      return result.rows.map((row) => ({
        gateType: asString(row.gate_type, 'gate_type'),
        gateKey: asString(row.gate_key, 'gate_key'),
        requiredAuthority: asString(row.required_authority, 'required_authority'),
        decision: asString(row.decision, 'decision'),
        value: row.value_json,
        evidenceRef: row.evidence_ref == null ? null : asString(row.evidence_ref, 'evidence_ref'),
        actorUserId: row.actor_user_id == null ? null : asString(row.actor_user_id, 'actor_user_id'),
        actorRole: row.actor_role == null ? null : asString(row.actor_role, 'actor_role'),
        idempotencyKey: asString(row.idempotency_key, 'idempotency_key'),
      }));
    } finally {
      connection.release();
    }
  }

  async requireActiveLease(input: ControlExecutionLease): Promise<ActiveExecutionLease> {
    const outcome = await this.transaction(async (connection): Promise<ActiveExecutionLease | null> => {
      const result = await connection.query(
        `SELECT attempt.id AS attempt_id, attempt.task_id, attempt.plan_version_id,
                attempt.lease_owner, attempt.lease_expires_at, task.state_version
         FROM control_execution_attempts AS attempt
         JOIN control_tasks AS task ON task.id = attempt.task_id
         WHERE attempt.id = $1
           AND attempt.task_id = $2
           AND attempt.plan_version_id = $3
           AND attempt.lease_owner = $4
           AND attempt.lease_token_hash = $5
           AND attempt.state = 'active'
           AND attempt.lease_expires_at > now()
           AND task.state IN ('executing', 'reviewing', 'composing_report')
           AND task.current_attempt_id = attempt.id
           AND task.active_plan_version_id = attempt.plan_version_id`,
        [input.attemptId, input.taskId, input.planVersionId, input.leaseOwner, hashLeaseToken(input.leaseToken)],
      );
      const row = result.rows[0];
      if (!row) {
        await this.pauseExpiredExecutionLease(connection, input);
        return null;
      }
      return {
        attemptId: asString(row.attempt_id, 'attempt_id'),
        taskId: asString(row.task_id, 'task_id'),
        planVersionId: asString(row.plan_version_id, 'plan_version_id'),
        leaseOwner: asString(row.lease_owner, 'lease_owner'),
        leaseExpiresAt: asDate(row.lease_expires_at, 'lease_expires_at'),
        stateVersion: asNumber(row.state_version, 'state_version'),
      };
    });
    if (!outcome) throw new ControlPlaneConflictError(`execution lease ${input.attemptId} is invalid or expired`);
    return outcome;
  }

  async heartbeatExecutionLease(input: ControlExecutionLease & { extendUntil: Date }): Promise<ActiveExecutionLease> {
    const outcome = await this.transaction(async (connection): Promise<ActiveExecutionLease | null> => {
      const result = await connection.query(
        `UPDATE control_execution_attempts AS attempt
         SET lease_heartbeat_at = now(),
             lease_expires_at = GREATEST(attempt.lease_expires_at, $6)
         FROM control_tasks AS task
         WHERE attempt.id = $1
           AND attempt.task_id = $2
           AND attempt.plan_version_id = $3
           AND attempt.lease_owner = $4
           AND attempt.lease_token_hash = $5
           AND attempt.state = 'active'
           AND attempt.lease_expires_at > now()
           AND task.id = attempt.task_id
           AND task.state IN ('executing', 'reviewing', 'composing_report')
           AND task.current_attempt_id = attempt.id
           AND task.active_plan_version_id = attempt.plan_version_id
         RETURNING attempt.id AS attempt_id, attempt.task_id, attempt.plan_version_id,
                   attempt.lease_owner, attempt.lease_expires_at, task.state_version`,
        [input.attemptId, input.taskId, input.planVersionId, input.leaseOwner, hashLeaseToken(input.leaseToken), input.extendUntil],
      );
      const row = result.rows[0];
      if (!row) {
        await this.pauseExpiredExecutionLease(connection, input);
        return null;
      }
      return {
        attemptId: asString(row.attempt_id, 'attempt_id'),
        taskId: asString(row.task_id, 'task_id'),
        planVersionId: asString(row.plan_version_id, 'plan_version_id'),
        leaseOwner: asString(row.lease_owner, 'lease_owner'),
        leaseExpiresAt: asDate(row.lease_expires_at, 'lease_expires_at'),
        stateVersion: asNumber(row.state_version, 'state_version'),
      };
    });
    if (!outcome) throw new ControlPlaneConflictError(`execution lease ${input.attemptId} cannot heartbeat`);
    return outcome;
  }

  async recordExecutionStep(input: ControlExecutionLease & {
    stepNo: number;
    stepName: string;
    actorType: string;
    actorId: string;
    state: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
    outputArtifactId?: string;
    toolProvenance?: Record<string, unknown>;
    skillProvenance?: Record<string, unknown>;
    failure?: Record<string, unknown>;
    latencyMs?: number;
    startedAt?: Date;
    finishedAt?: Date;
  }): Promise<void> {
    if (
      (input.state === 'pending' || input.state === 'running')
      && (
        input.outputArtifactId !== undefined
        || input.toolProvenance !== undefined
        || input.skillProvenance !== undefined
        || input.failure !== undefined
        || input.latencyMs !== undefined
        || input.finishedAt !== undefined
      )
    ) {
      throw new ControlPlaneConflictError(
        `execution step ${input.attemptId}/${input.stepNo} cannot attach terminal evidence while ${input.state}`,
      );
    }
    const accepted = await this.transaction(async (connection): Promise<boolean> => {
      const taskResult = await connection.query(
        `SELECT state, current_attempt_id, active_plan_version_id
         FROM control_tasks
         WHERE id = $1
         FOR UPDATE`,
        [input.taskId],
      );
      const task = taskResult.rows[0];
      if (
        !task
        || !['executing', 'reviewing', 'composing_report'].includes(asString(task.state, 'state'))
        || task.current_attempt_id !== input.attemptId
        || task.active_plan_version_id !== input.planVersionId
      ) {
        return false;
      }
      const attemptResult = await connection.query(
        `SELECT 1
         FROM control_execution_attempts
         WHERE id = $1
           AND task_id = $2
           AND plan_version_id = $3
           AND lease_owner = $4
           AND lease_token_hash = $5
           AND state = 'active'
           AND lease_expires_at > now()
         FOR UPDATE`,
        [input.attemptId, input.taskId, input.planVersionId, input.leaseOwner, hashLeaseToken(input.leaseToken)],
      );
      if (!attemptResult.rows[0]) {
        await this.pauseExpiredExecutionLease(connection, input);
        return false;
      }
      const recorded = await connection.query(
        `INSERT INTO control_execution_steps
           (attempt_id, step_no, step_name, actor_type, actor_id, state,
            output_artifact_id, tool_provenance, skill_provenance, failure_json, latency_ms, started_at, finished_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (attempt_id, step_no) DO UPDATE
         SET step_name = control_execution_steps.step_name,
             actor_type = control_execution_steps.actor_type,
             actor_id = control_execution_steps.actor_id,
             state = EXCLUDED.state,
             output_artifact_id = CASE
               WHEN control_execution_steps.state IN ('succeeded', 'failed', 'skipped')
                 THEN control_execution_steps.output_artifact_id
               WHEN EXCLUDED.state IN ('succeeded', 'failed', 'skipped')
                 THEN EXCLUDED.output_artifact_id
               ELSE control_execution_steps.output_artifact_id
             END,
             tool_provenance = CASE
               WHEN control_execution_steps.state IN ('succeeded', 'failed', 'skipped')
                 THEN control_execution_steps.tool_provenance
               WHEN EXCLUDED.state IN ('succeeded', 'failed', 'skipped')
                 THEN EXCLUDED.tool_provenance
               ELSE control_execution_steps.tool_provenance
             END,
             skill_provenance = CASE
               WHEN control_execution_steps.state IN ('succeeded', 'failed', 'skipped')
                 THEN control_execution_steps.skill_provenance
               WHEN EXCLUDED.state IN ('succeeded', 'failed', 'skipped')
                 THEN EXCLUDED.skill_provenance
               ELSE control_execution_steps.skill_provenance
             END,
             failure_json = CASE
               WHEN control_execution_steps.state IN ('succeeded', 'failed', 'skipped')
                 THEN control_execution_steps.failure_json
               WHEN EXCLUDED.state IN ('succeeded', 'failed', 'skipped')
                 THEN EXCLUDED.failure_json
               ELSE control_execution_steps.failure_json
             END,
             latency_ms = CASE
               WHEN control_execution_steps.state IN ('succeeded', 'failed', 'skipped')
                 THEN control_execution_steps.latency_ms
               WHEN EXCLUDED.state IN ('succeeded', 'failed', 'skipped')
                 THEN EXCLUDED.latency_ms
               ELSE control_execution_steps.latency_ms
             END,
             started_at = CASE
               WHEN control_execution_steps.state IN ('succeeded', 'failed', 'skipped')
                 THEN control_execution_steps.started_at
               ELSE COALESCE(control_execution_steps.started_at, EXCLUDED.started_at)
             END,
             finished_at = CASE
               WHEN control_execution_steps.state IN ('succeeded', 'failed', 'skipped')
                 THEN control_execution_steps.finished_at
               WHEN EXCLUDED.state IN ('succeeded', 'failed', 'skipped')
                 THEN EXCLUDED.finished_at
               ELSE control_execution_steps.finished_at
             END
         WHERE (
            control_execution_steps.state IN ('succeeded', 'failed', 'skipped')
              AND control_execution_steps.state = EXCLUDED.state
              AND control_execution_steps.step_name = EXCLUDED.step_name
              AND control_execution_steps.actor_type = EXCLUDED.actor_type
              AND control_execution_steps.actor_id = EXCLUDED.actor_id
              AND control_execution_steps.output_artifact_id IS NOT DISTINCT FROM EXCLUDED.output_artifact_id
              AND control_execution_steps.tool_provenance IS NOT DISTINCT FROM EXCLUDED.tool_provenance
              AND control_execution_steps.skill_provenance IS NOT DISTINCT FROM EXCLUDED.skill_provenance
              AND control_execution_steps.failure_json IS NOT DISTINCT FROM EXCLUDED.failure_json
              AND control_execution_steps.latency_ms IS NOT DISTINCT FROM EXCLUDED.latency_ms
              AND control_execution_steps.started_at IS NOT DISTINCT FROM EXCLUDED.started_at
              AND control_execution_steps.finished_at IS NOT DISTINCT FROM EXCLUDED.finished_at
            )
            OR (
              control_execution_steps.state = 'pending'
              AND EXCLUDED.state IN ('pending', 'running', 'succeeded', 'failed', 'skipped')
              AND control_execution_steps.step_name = EXCLUDED.step_name
              AND control_execution_steps.actor_type = EXCLUDED.actor_type
              AND control_execution_steps.actor_id = EXCLUDED.actor_id
            )
            OR (
              control_execution_steps.state = 'running'
              AND EXCLUDED.state IN ('succeeded', 'failed', 'skipped')
              AND control_execution_steps.step_name = EXCLUDED.step_name
              AND control_execution_steps.actor_type = EXCLUDED.actor_type
              AND control_execution_steps.actor_id = EXCLUDED.actor_id
            )
         RETURNING attempt_id`,
        [
          input.attemptId, input.stepNo, input.stepName, input.actorType, input.actorId, input.state,
          input.outputArtifactId ?? null,
          input.toolProvenance == null ? null : JSON.stringify(input.toolProvenance),
          input.skillProvenance == null ? null : JSON.stringify(input.skillProvenance),
          input.failure == null ? null : JSON.stringify(input.failure),
          input.latencyMs ?? null, input.startedAt ?? null, input.finishedAt ?? null,
        ],
      );
      if (!recorded.rows[0]) {
        throw new ControlPlaneConflictError(
          `execution step ${input.attemptId}/${input.stepNo} cannot transition to ${input.state}`,
        );
      }
      return true;
    });
    if (!accepted) {
      throw new ControlPlaneConflictError(`execution lease ${input.attemptId} cannot record step ${input.stepNo}`);
    }
  }

  async recordLeaseLostExecutionStep(input: ControlExecutionLease & {
    stepNo: number;
    stepName: string;
    actorType: string;
    actorId: string;
    failure: Record<string, unknown>;
    toolProvenance?: Record<string, unknown>;
    skillProvenance?: Record<string, unknown>;
    startedAt?: Date;
    finishedAt?: Date;
  }): Promise<boolean> {
    if (input.failure.kind !== 'lease_lost') return false;
    return this.transaction(async (connection) => {
      const task = await connection.query(
        `SELECT 1 FROM control_tasks
         WHERE id = $1
           AND state = 'paused'
           AND current_attempt_id = $2
           AND active_plan_version_id = $3
         FOR UPDATE`,
        [input.taskId, input.attemptId, input.planVersionId],
      );
      if (!task.rows[0]) return false;
      const attempt = await connection.query(
        `SELECT 1 FROM control_execution_attempts
         WHERE id = $1
           AND task_id = $2
           AND plan_version_id = $3
           AND lease_owner = $4
           AND lease_token_hash = $5
           AND state = 'paused'
           AND failure_kind = 'worker_loss'
         FOR UPDATE`,
        [input.attemptId, input.taskId, input.planVersionId, input.leaseOwner, hashLeaseToken(input.leaseToken)],
      );
      if (!attempt.rows[0]) return false;
      const updated = await connection.query(
        `UPDATE control_execution_steps
         SET step_name = $7,
             actor_type = $8,
             actor_id = $9,
             state = 'failed',
             tool_provenance = $3,
             skill_provenance = $4,
             failure_json = $5,
             started_at = CASE
               WHEN state = 'failed'
                 AND step_name = 'worker lease expired'
                 AND actor_type = 'system'
                 AND actor_id = 'worker-loss'
                 AND failure_json->>'kind' = 'worker_loss'
                 THEN $10
               ELSE COALESCE(started_at, $10)
             END,
             finished_at = $6
         WHERE attempt_id = $1
           AND step_no = $2
           AND (
             (
               step_name = $7
               AND actor_type = $8
               AND actor_id = $9
               AND (
                 state = 'running'
                 OR (
                   state = 'failed'
                   AND failure_json->>'kind' = 'worker_loss'
                 )
               )
             )
             OR (
               state = 'failed'
               AND step_name = 'worker lease expired'
               AND actor_type = 'system'
               AND actor_id = 'worker-loss'
               AND failure_json->>'kind' = 'worker_loss'
             )
           )
         RETURNING attempt_id`,
        [
          input.attemptId,
          input.stepNo,
          input.toolProvenance == null ? null : JSON.stringify(input.toolProvenance),
          input.skillProvenance == null ? null : JSON.stringify(input.skillProvenance),
          JSON.stringify(input.failure),
          input.finishedAt ?? new Date(),
          input.stepName,
          input.actorType,
          input.actorId,
          input.startedAt ?? new Date(),
        ],
      );
      if (updated.rows[0]) return true;
      const alreadyRecorded = await connection.query(
        `SELECT 1
         FROM control_execution_steps
         WHERE attempt_id = $1
           AND step_no = $2
           AND step_name = $3
           AND actor_type = $4
           AND actor_id = $5
           AND state = 'failed'
           AND failure_json->>'kind' = 'lease_lost'
           AND tool_provenance IS NOT DISTINCT FROM $6::jsonb
           AND skill_provenance IS NOT DISTINCT FROM $7::jsonb
           AND failure_json IS NOT DISTINCT FROM $8::jsonb`,
        [
          input.attemptId,
          input.stepNo,
          input.stepName,
          input.actorType,
          input.actorId,
          input.toolProvenance == null ? null : JSON.stringify(input.toolProvenance),
          input.skillProvenance == null ? null : JSON.stringify(input.skillProvenance),
          JSON.stringify(input.failure),
        ],
      );
      if (alreadyRecorded.rows[0]) return true;
      const inserted = await connection.query(
        `INSERT INTO control_execution_steps
           (attempt_id, step_no, step_name, actor_type, actor_id, state,
            tool_provenance, skill_provenance, failure_json, started_at, finished_at)
         VALUES ($1, $2, $3, $4, $5, 'failed', $6, $7, $8, $9, $10)
         ON CONFLICT (attempt_id, step_no) DO NOTHING
         RETURNING attempt_id`,
        [
          input.attemptId,
          input.stepNo,
          input.stepName,
          input.actorType,
          input.actorId,
          input.toolProvenance == null ? null : JSON.stringify(input.toolProvenance),
          input.skillProvenance == null ? null : JSON.stringify(input.skillProvenance),
          JSON.stringify(input.failure),
          input.startedAt ?? new Date(),
          input.finishedAt ?? new Date(),
        ],
      );
      return Boolean(inserted.rows[0]);
    });
  }

  async clearExecutionStepArtifactInvalidationPromotion(input: ControlExecutionLease & {
    stepNo: number;
    stepName: string;
    actorType: string;
    actorId: string;
    expectedPreviousFailure: Record<string, unknown>;
  }): Promise<Record<string, unknown> | null> {
    const markerArtifactIds = artifactInvalidationPromotionArtifactIds(input.expectedPreviousFailure);
    if (!markerArtifactIds) return null;
    const publicFailure = strippedExecutionFailure(input.expectedPreviousFailure)!;
    const expectedFailureHash = `sha256:${createHash('sha256')
      .update(JSON.stringify(stableValue(input.expectedPreviousFailure)))
      .digest('hex')}`;
    const clearedFailure: Record<string, unknown> = {
      ...publicFailure,
      artifactInvalidationClearReceipt: {
        version: ARTIFACT_INVALIDATION_CLEAR_RECEIPT_VERSION,
        expectedFailureHash,
      },
    };
    const serializedExpectedFailure = JSON.stringify(input.expectedPreviousFailure);
    const serializedClearedFailure = JSON.stringify(clearedFailure);
    return this.transaction(async (connection) => {
      const task = await connection.query(
        `SELECT state
         FROM control_tasks
         WHERE id = $1
           AND state IN ('executing', 'reviewing', 'composing_report', 'paused')
           AND current_attempt_id = $2
           AND active_plan_version_id = $3
         FOR UPDATE`,
        [input.taskId, input.attemptId, input.planVersionId],
      );
      if (!task.rows[0]) return null;
      const attempt = await connection.query(
        `SELECT state, failure_kind, lease_expires_at > now() AS lease_current
         FROM control_execution_attempts
         WHERE id = $1
           AND task_id = $2
           AND plan_version_id = $3
           AND lease_owner = $4
           AND lease_token_hash = $5
           AND state IN ('active', 'paused')
         FOR UPDATE`,
        [
          input.attemptId,
          input.taskId,
          input.planVersionId,
          input.leaseOwner,
          hashLeaseToken(input.leaseToken),
        ],
      );
      const taskState = asString(task.rows[0].state, 'state');
      const attemptRow = attempt.rows[0];
      const activeLease = attemptRow?.state === 'active'
        && attemptRow.lease_current === true
        && ['executing', 'reviewing', 'composing_report'].includes(taskState);
      const currentPausedRecovery = attemptRow?.state === 'paused'
        && (attemptRow.failure_kind === 'worker_loss' || attemptRow.failure_kind === 'artifact_invalidation')
        && taskState === 'paused';
      if (!activeLease && !currentPausedRecovery) return null;
      const step = await connection.query(
        `SELECT failure_json IS NOT DISTINCT FROM $6::jsonb AS matches_expected,
                failure_json IS NOT DISTINCT FROM $7::jsonb AS already_cleared
         FROM control_execution_steps
         WHERE attempt_id = $1
           AND step_no = $2
           AND step_name = $3
           AND actor_type = $4
           AND actor_id = $5
           AND state = 'failed'
         FOR UPDATE`,
        [
          input.attemptId,
          input.stepNo,
          input.stepName,
          input.actorType,
          input.actorId,
          serializedExpectedFailure,
          serializedClearedFailure,
        ],
      );
      const stepRow = step.rows[0];
      if (!stepRow || (stepRow.matches_expected !== true && stepRow.already_cleared !== true)) return null;
      const failedArtifacts = await connection.query(
        `SELECT id
         FROM control_artifacts
         WHERE id::text = ANY($1::text[])
           AND task_id = $2
           AND plan_version_id = $3
           AND attempt_id = $4
           AND state = 'FAILED'
         ORDER BY id`,
        [markerArtifactIds, input.taskId, input.planVersionId, input.attemptId],
      );
      if (failedArtifacts.rows.length !== markerArtifactIds.length) return null;
      if (stepRow.already_cleared === true) return publicFailure;
      const updated = await connection.query(
        `UPDATE control_execution_steps
         SET failure_json = $6
         WHERE attempt_id = $1
           AND step_no = $2
           AND step_name = $3
           AND actor_type = $4
           AND actor_id = $5
           AND state = 'failed'
           AND failure_json IS NOT DISTINCT FROM $7::jsonb
         RETURNING attempt_id`,
        [
          input.attemptId,
          input.stepNo,
          input.stepName,
          input.actorType,
          input.actorId,
          serializedClearedFailure,
          serializedExpectedFailure,
        ],
      );
      return updated.rows[0] ? publicFailure : null;
    });
  }

  async promoteExecutionStepArtifactInvalidation(input: ControlExecutionLease & {
    stepNo: number;
    stepName: string;
    actorType: string;
    actorId: string;
    failedArtifactIds: string[];
    expectedPreviousFailure?: Record<string, unknown>;
  }): Promise<Record<string, unknown> | null> {
    const failedArtifactIds = [...input.failedArtifactIds].sort();
    if (
      failedArtifactIds.length === 0
      || failedArtifactIds.some((artifactId) => typeof artifactId !== 'string')
      || new Set(failedArtifactIds).size !== failedArtifactIds.length
    ) return null;
    return this.transaction(async (connection) => {
      const task = await connection.query(
        `SELECT state
         FROM control_tasks
         WHERE id = $1
           AND state IN ('executing', 'reviewing', 'composing_report', 'paused')
           AND current_attempt_id = $2
           AND active_plan_version_id = $3
         FOR UPDATE`,
        [input.taskId, input.attemptId, input.planVersionId],
      );
      const taskRow = task.rows[0];
      if (!taskRow) return null;
      const attempt = await connection.query(
        `SELECT state, failure_kind, lease_expires_at > now() AS lease_current
         FROM control_execution_attempts
         WHERE id = $1
           AND task_id = $2
           AND plan_version_id = $3
           AND lease_owner = $4
           AND lease_token_hash = $5
           AND state IN ('active', 'paused')
         FOR UPDATE`,
        [
          input.attemptId,
          input.taskId,
          input.planVersionId,
          input.leaseOwner,
          hashLeaseToken(input.leaseToken),
        ],
      );
      let attemptRow = attempt.rows[0];
      if (!attemptRow) return null;
      let taskState = asString(taskRow.state, 'state');
      if (attemptRow.state === 'active' && attemptRow.lease_current !== true) {
        const recoveredTask = await this.pauseExpiredExecutionLease(connection, input);
        if (!recoveredTask) return null;
        const recoveredAttempt = await connection.query(
          `SELECT state, failure_kind, false AS lease_current
           FROM control_execution_attempts
           WHERE id = $1
             AND task_id = $2
             AND plan_version_id = $3
             AND lease_owner = $4
             AND lease_token_hash = $5
             AND state = 'paused'`,
          [
            input.attemptId,
            input.taskId,
            input.planVersionId,
            input.leaseOwner,
            hashLeaseToken(input.leaseToken),
          ],
        );
        attemptRow = recoveredAttempt.rows[0];
        if (!attemptRow) return null;
        taskState = recoveredTask.state;
      }
      if (
        (attemptRow.state === 'active'
          && !['executing', 'reviewing', 'composing_report'].includes(taskState))
        || (
          attemptRow.state === 'paused'
          && (
            taskState !== 'paused'
            || (
              attemptRow.failure_kind !== 'worker_loss'
              && attemptRow.failure_kind !== 'artifact_invalidation'
            )
          )
        )
      ) return null;
      const workerLossFailure = {
        kind: 'worker_loss',
        retryable: true,
        allowedActions: ['retry', 'abort'],
      };
      const step = await connection.query(
        `SELECT failure_json,
                failure_json IS NOT DISTINCT FROM $6::jsonb AS is_worker_loss,
                ($7::jsonb IS NOT NULL AND failure_json IS NOT DISTINCT FROM $7::jsonb) AS matches_expected
         FROM control_execution_steps
         WHERE attempt_id = $1
           AND step_no = $2
           AND step_name = $3
           AND actor_type = $4
           AND actor_id = $5
           AND state = 'failed'
         FOR UPDATE`,
        [
          input.attemptId,
          input.stepNo,
          input.stepName,
          input.actorType,
          input.actorId,
          JSON.stringify(workerLossFailure),
          input.expectedPreviousFailure == null
            ? null
            : JSON.stringify(input.expectedPreviousFailure),
        ],
      );
      const stepRow = step.rows[0];
      const previousFailure = asRecord(stepRow?.failure_json);
      if (!previousFailure) return null;
      const markerArtifactIds = artifactInvalidationPromotionArtifactIds(previousFailure);
      const markerAllowsPromotion = stepRow.matches_expected === true
        && markerArtifactIds !== null
        && failedArtifactIds.every((artifactId) => markerArtifactIds.includes(artifactId));
      const nextFailure: Record<string, unknown> = {
        ...previousFailure,
        kind: 'artifact_invalidation',
        retryable: false,
        message: 'unpublished step Artifact could not be invalidated',
        failedArtifactIds,
        allowedActions: ['abort'],
      };
      delete nextFailure.artifactInvalidationPromotion;
      const serializedNextFailure = JSON.stringify(nextFailure);
      const alreadyRecorded = await connection.query(
        `SELECT 1
         FROM control_execution_steps
         WHERE attempt_id = $1
           AND step_no = $2
           AND failure_json IS NOT DISTINCT FROM $3::jsonb`,
        [input.attemptId, input.stepNo, serializedNextFailure],
      );
      if (alreadyRecorded.rows[0]) {
        if (attemptRow.state === 'paused' && attemptRow.failure_kind === 'worker_loss') {
          const promotedAttempt = await connection.query(
            `UPDATE control_execution_attempts
             SET failure_kind = 'artifact_invalidation'
             WHERE id = $1 AND state = 'paused' AND failure_kind = 'worker_loss'
             RETURNING id`,
            [input.attemptId],
          );
          if (!promotedAttempt.rows[0]) {
            throw new ControlPlaneConflictError(
              `execution attempt ${input.attemptId} changed during Artifact invalidation promotion`,
            );
          }
        }
        return nextFailure;
      }
      if (previousFailure.kind === 'artifact_invalidation') return null;
      if (attemptRow.state === 'paused' && attemptRow.failure_kind !== 'worker_loss') return null;
      const promotable = attemptRow.state === 'active'
        ? markerAllowsPromotion
        : stepRow.is_worker_loss === true
          || markerAllowsPromotion;
      if (!promotable) return null;
      const residualArtifacts = await connection.query(
        `SELECT id
         FROM control_artifacts
         WHERE id::text = ANY($1::text[])
           AND task_id = $2
           AND plan_version_id = $3
           AND attempt_id = $4
           AND state IN ('STAGING', 'SEALED')
         ORDER BY id
         FOR UPDATE`,
        [failedArtifactIds, input.taskId, input.planVersionId, input.attemptId],
      );
      if (residualArtifacts.rows.length !== failedArtifactIds.length) return null;
      const updated = await connection.query(
        `UPDATE control_execution_steps
         SET failure_json = $6
         WHERE attempt_id = $1
           AND step_no = $2
           AND step_name = $3
           AND actor_type = $4
           AND actor_id = $5
           AND state = 'failed'
           AND failure_json IS NOT DISTINCT FROM $7::jsonb
         RETURNING attempt_id`,
        [
          input.attemptId,
          input.stepNo,
          input.stepName,
          input.actorType,
          input.actorId,
          serializedNextFailure,
          JSON.stringify(previousFailure),
        ],
      );
      if (!updated.rows[0]) return null;
      if (attemptRow.state === 'paused') {
        const promotedAttempt = await connection.query(
          `UPDATE control_execution_attempts
           SET failure_kind = 'artifact_invalidation'
           WHERE id = $1 AND state = 'paused' AND failure_kind = 'worker_loss'
           RETURNING id`,
          [input.attemptId],
        );
        if (!promotedAttempt.rows[0]) {
          throw new ControlPlaneConflictError(
            `execution attempt ${input.attemptId} changed during Artifact invalidation promotion`,
          );
        }
      }
      return nextFailure;
    });
  }

  async listExecutionSteps(attemptId: string): Promise<ControlExecutionStep[]> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        `SELECT step_no, step_name, actor_type, actor_id, state, output_artifact_id,
                tool_provenance, skill_provenance, failure_json, latency_ms,
                started_at, finished_at
         FROM control_execution_steps WHERE attempt_id = $1 ORDER BY step_no`,
        [attemptId],
      );
      return result.rows.map((row) => ({
        stepNo: asNumber(row.step_no, 'step_no'),
        stepName: asString(row.step_name, 'step_name'),
        actorType: asString(row.actor_type, 'actor_type'),
        actorId: asString(row.actor_id, 'actor_id'),
        state: asString(row.state, 'state'),
        outputArtifactId: typeof row.output_artifact_id === 'string' ? row.output_artifact_id : null,
        toolProvenance: asRecord(row.tool_provenance),
        skillProvenance: asRecord(row.skill_provenance),
        failure: publicExecutionStepFailure(row),
        latencyMs: row.latency_ms == null ? null : asNumber(row.latency_ms, 'latency_ms'),
        startedAt: row.started_at == null ? null : asDate(row.started_at, 'started_at'),
        finishedAt: row.finished_at == null ? null : asDate(row.finished_at, 'finished_at'),
      }));
    } finally {
      connection.release();
    }
  }

  async recordModelCall(input: {
    attemptId?: string;
    stage: string;
    stepNo?: number;
    provider: string;
    endpointHost: string;
    requestedModel: string;
    actualModel: string;
    modelVersion?: string;
    promptHash: string;
    contextManifestHash?: string;
    traceId?: string;
    tokens?: { prompt: number; completion: number; total: number };
    status: 'succeeded' | 'failed';
    failure: Record<string, unknown> | null;
    startedAt: Date;
    finishedAt: Date;
  }): Promise<string> {
    return this.transaction(async (connection) => {
      const result = await connection.query(
        `INSERT INTO control_model_calls
           (attempt_id, stage, step_no, provider, endpoint_host, requested_model, actual_model, model_version,
            prompt_hash, context_manifest_hash, trace_id, tokens_json, status, failure_json, started_at, finished_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         RETURNING id`,
        [
          input.attemptId ?? null, input.stage, input.stepNo ?? null, input.provider, input.endpointHost,
          input.requestedModel, input.actualModel, input.modelVersion ?? 'unknown', input.promptHash,
          input.contextManifestHash ?? null, input.traceId ?? null,
          input.tokens == null ? null : JSON.stringify(input.tokens), input.status,
          input.failure == null ? null : JSON.stringify(input.failure), input.startedAt, input.finishedAt,
        ],
      );
      return asString(result.rows[0]?.id, 'model_call_id');
    });
  }

  async listModelCalls(attemptId: string): Promise<ControlModelCall[]> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        `SELECT id, stage, step_no, provider, endpoint_host, requested_model, actual_model, model_version,
                prompt_hash, context_manifest_hash, trace_id, tokens_json, status, failure_json
         FROM control_model_calls WHERE attempt_id = $1 ORDER BY started_at`,
        [attemptId],
      );
      return result.rows.map(modelCallFromRow);
    } finally {
      connection.release();
    }
  }

  async getModelCall(modelCallId: string): Promise<ControlModelCall | null> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        `SELECT id, stage, step_no, provider, endpoint_host, requested_model, actual_model, model_version,
                prompt_hash, context_manifest_hash, trace_id, tokens_json, status, failure_json
         FROM control_model_calls WHERE id = $1`,
        [modelCallId],
      );
      return result.rows[0] ? modelCallFromRow(result.rows[0]) : null;
    } finally {
      connection.release();
    }
  }

  async findPersistedIndependentReview(attemptId: string): Promise<PersistedIndependentReview | null> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        `SELECT review.reviewer_user_id, reviewer.status AS reviewer_status,
                review.independence_json, review.verdict
         FROM gold_reviews AS review
         JOIN users AS reviewer ON reviewer.id = review.reviewer_user_id
         WHERE review.attempt_id = $1
         ORDER BY review.created_at DESC
         LIMIT 1`,
        [attemptId],
      );
      const row = result.rows[0];
      if (!row) return null;
      const independence = asRecord(row.independence_json);
      const independent = independence !== null
        && independence.capabilityOwner === false
        && independence.operator === false
        && independence.artifactEditor === false;
      return {
        reviewerId: asString(row.reviewer_user_id, 'reviewer_user_id'),
        authenticated: row.reviewer_status === 'active',
        independent,
        verdict: asString(row.verdict, 'verdict'),
      };
    } finally {
      connection.release();
    }
  }

  async completeExecution(
    input: ControlExecutionLease,
    options: {
      status: 'completed' | 'completed_with_gaps';
      reportPackageArtifactId?: string;
      finalReportArtifactId?: string;
    } = { status: 'completed' },
  ): Promise<ControlTask> {
    const outcome = await this.transaction(async (connection): Promise<ControlTask | null> => {
      const lockedTask = await connection.query(
        `SELECT 1 FROM control_tasks
         WHERE id = $1
           AND state IN ('executing', 'reviewing', 'composing_report')
           AND current_attempt_id = $2
           AND active_plan_version_id = $3
         FOR UPDATE`,
        [input.taskId, input.attemptId, input.planVersionId],
      );
      if (!lockedTask.rows[0]) {
        throw new ControlPlaneConflictError(`task ${input.taskId} is not executing attempt ${input.attemptId}`);
      }
      if (options.reportPackageArtifactId && options.finalReportArtifactId) {
        throw new ControlPlaneConflictError('execution cannot complete with two terminal report roots');
      }
      if (options.reportPackageArtifactId) {
        const selectedPackage = await connection.query(
          `SELECT id, storage_uri
           FROM control_artifacts
           WHERE id = $1
             AND task_id = $2
             AND plan_version_id = $3
             AND attempt_id = $4
             AND kind = 'report_package'
             AND schema_version IN ('report-package-v1', 'report-package-v2', 'report-package-v3')
             AND state = 'SEALED'
             AND content_sha256 IS NOT NULL
             AND byte_size IS NOT NULL
           FOR SHARE`,
          [
            options.reportPackageArtifactId,
            input.taskId,
            input.planVersionId,
            input.attemptId,
          ],
        );
        const selectedRow = selectedPackage.rows[0];
        const storageUri = selectedRow ? asString(selectedRow.storage_uri, 'storage_uri') : '';
        if (!selectedRow || !/(?:^|\/)reports\/report-package(?:-v3)?\.json$/u.test(storageUri)) {
          throw new ControlPlaneConflictError(
            `execution ${input.attemptId} Report Package root is not a sealed fixed-path Artifact`,
          );
        }
        const packageRoots = await connection.query(
          `SELECT id
           FROM control_artifacts
           WHERE task_id = $1
             AND plan_version_id = $2
             AND attempt_id = $3
             AND kind = 'report_package'
             AND storage_uri = $4
             AND state = 'SEALED'
           ORDER BY id
           FOR SHARE`,
          [input.taskId, input.planVersionId, input.attemptId, storageUri],
        );
        if (
          packageRoots.rows.length !== 1
          || asString(packageRoots.rows[0]?.id, 'id') !== options.reportPackageArtifactId
        ) {
          throw new ControlPlaneConflictError(
            `execution ${input.attemptId} does not have one unique sealed Report Package root`,
          );
        }
      }
      if (options.finalReportArtifactId) {
        const selectedReport = await connection.query(
          `SELECT id, storage_uri
           FROM control_artifacts
           WHERE id = $1
             AND task_id = $2
             AND plan_version_id = $3
             AND attempt_id = $4
             AND kind = 'final_report'
             AND schema_version = 'native-final-report-v1'
             AND state = 'SEALED'
             AND content_sha256 IS NOT NULL
             AND byte_size IS NOT NULL
           FOR SHARE`,
          [
            options.finalReportArtifactId,
            input.taskId,
            input.planVersionId,
            input.attemptId,
          ],
        );
        const selectedRow = selectedReport.rows[0];
        const storageUri = selectedRow ? asString(selectedRow.storage_uri, 'storage_uri') : '';
        if (!selectedRow || !/(?:^|\/)reports\/final-report\.json$/u.test(storageUri)) {
          throw new ControlPlaneConflictError(
            `execution ${input.attemptId} NativeFinalReport root is not a sealed fixed-path Artifact`,
          );
        }
        const reportRoots = await connection.query(
          `SELECT id
           FROM control_artifacts
           WHERE task_id = $1
             AND plan_version_id = $2
             AND attempt_id = $3
             AND kind = 'final_report'
             AND storage_uri = $4
             AND state = 'SEALED'
           ORDER BY id
           FOR SHARE`,
          [input.taskId, input.planVersionId, input.attemptId, storageUri],
        );
        if (
          reportRoots.rows.length !== 1
          || asString(reportRoots.rows[0]?.id, 'id') !== options.finalReportArtifactId
        ) {
          throw new ControlPlaneConflictError(
            `execution ${input.attemptId} does not have one unique sealed NativeFinalReport root`,
          );
        }
      }
      const attempt = await connection.query(
        `UPDATE control_execution_attempts
         SET state = 'completed', finished_at = now()
         WHERE id = $1
           AND task_id = $2
           AND plan_version_id = $3
           AND lease_owner = $4
           AND lease_token_hash = $5
           AND state = 'active'
           AND lease_expires_at > now()
         RETURNING id`,
        [input.attemptId, input.taskId, input.planVersionId, input.leaseOwner, hashLeaseToken(input.leaseToken)],
      );
      if (!attempt.rows[0]) {
        await this.pauseExpiredExecutionLease(connection, input);
        return null;
      }
      const unfinishedStep = await connection.query(
        `SELECT step_no, state
         FROM control_execution_steps
         WHERE attempt_id = $1 AND state IN ('pending', 'running')
         ORDER BY step_no
         LIMIT 1`,
        [input.attemptId],
      );
      if (unfinishedStep.rows[0]) {
        throw new ControlPlaneConflictError(
          `execution ${input.attemptId} cannot complete with ${asString(unfinishedStep.rows[0].state, 'state')} step ${asNumber(unfinishedStep.rows[0].step_no, 'step_no')}`,
        );
      }
      const task = await connection.query(
        `UPDATE control_tasks
         SET state = $4, state_version = state_version + 1, updated_at = now()
         WHERE id = $1
           AND state IN ('executing', 'reviewing', 'composing_report')
           AND current_attempt_id = $2
           AND active_plan_version_id = $3
         RETURNING id, state, state_version, active_plan_version_id, current_attempt_id`,
        [input.taskId, input.attemptId, input.planVersionId, options.status],
      );
      const row = task.rows[0];
      if (!row) throw new ControlPlaneConflictError(`task ${input.taskId} is not executing attempt ${input.attemptId}`);
      return {
        id: asString(row.id, 'id'),
        state: asString(row.state, 'state') as ControlTaskState,
        stateVersion: asNumber(row.state_version, 'state_version'),
        activePlanVersionId: typeof row.active_plan_version_id === 'string' ? row.active_plan_version_id : null,
        currentAttemptId: typeof row.current_attempt_id === 'string' ? row.current_attempt_id : null,
      };
    });
    if (!outcome) throw new ControlPlaneConflictError(`execution lease ${input.attemptId} cannot complete`);
    return outcome;
  }

  async expireExecutionLease(input: { taskId: string; attemptId: string }): Promise<ControlTask> {
    return this.transaction(async (connection) => {
      const task = await this.pauseExpiredExecutionLease(connection, input);
      if (!task) {
        throw new ControlPlaneConflictError(`execution lease ${input.attemptId} is not expired and active`);
      }
      const failedSteps = await connection.query(
        `SELECT failure_json
         FROM control_execution_steps
         WHERE attempt_id = $1 AND state = 'failed'`,
        [input.attemptId],
      );
      const represented = failedSteps.rows.some((row) => {
        const failure = asRecord(row.failure_json);
        return failure?.kind === 'worker_loss'
          || failure?.kind === 'artifact_invalidation'
          || artifactInvalidationPromotionArtifactIds(failure) !== null;
      });
      if (!represented) {
        await connection.query(
          `INSERT INTO control_execution_steps
             (attempt_id, step_no, step_name, actor_type, actor_id, state,
              failure_json, started_at, finished_at)
           SELECT $1, COALESCE(MAX(step_no), 0) + 1,
                  'worker lease expired', 'system', 'worker-loss', 'failed', $2, now(), now()
           FROM control_execution_steps
           WHERE attempt_id = $1`,
          [
            input.attemptId,
            JSON.stringify({
              kind: 'worker_loss',
              retryable: true,
              allowedActions: ['retry', 'abort'],
            }),
          ],
        );
      }
      return task;
    });
  }

  async retryPausedExecution(input: {
    taskId: string;
    attemptId: string;
    expectedVersion: number;
    failedStepNo?: number;
  }): Promise<ControlTask | null> {
    return this.transaction(async (connection) => {
      const task = await connection.query(
        `SELECT active_plan_version_id
         FROM control_tasks
         WHERE id = $1
           AND state = 'paused'
           AND state_version = $2
           AND current_attempt_id = $3
         FOR UPDATE`,
        [input.taskId, input.expectedVersion, input.attemptId],
      );
      const taskRow = task.rows[0];
      if (!taskRow) {
        throw new ControlPlaneConflictError(
          `task ${input.taskId} cannot retry attempt ${input.attemptId}`,
        );
      }
      const planVersionId = asString(taskRow.active_plan_version_id, 'active_plan_version_id');
      const attempt = await connection.query(
        `SELECT failure_kind
         FROM control_execution_attempts
         WHERE id = $1
           AND task_id = $2
           AND plan_version_id = $3
           AND state = 'paused'
         FOR UPDATE`,
        [input.attemptId, input.taskId, planVersionId],
      );
      const attemptRow = attempt.rows[0];
      if (!attemptRow) {
        throw new ControlPlaneConflictError(`attempt ${input.attemptId} is not paused`);
      }
      const persistedSteps = await connection.query(
        `SELECT step_no, state, actor_type, skill_provenance, failure_json
         FROM control_execution_steps
         WHERE attempt_id = $1
         ORDER BY step_no
         FOR UPDATE`,
        [input.attemptId],
      );
      const authoritativeFailure = selectAuthoritativeFailedStep(
        persistedSteps.rows.map((row) => ({
          stepNo: asNumber(row.step_no, 'step_no'),
          state: asString(row.state, 'state'),
          failure: publicExecutionStepFailure(row),
        })),
      );
      if (
        input.failedStepNo != null
        && authoritativeFailure?.stepNo !== input.failedStepNo
      ) return null;
      if (
        authoritativeFailure
        && !executionFailureAllowsAction(authoritativeFailure.failure, 'retry')
      ) return null;
      if (attemptRow.failure_kind === 'worker_loss') {
        // Keep this read lock-free: a late seal may already hold the Artifact row
        // before it enters pauseExpiredExecutionLease. Old MVCC states are still
        // conservative here (STAGING/SEALED/pending quarantine all block retry).
        const residualArtifacts = await connection.query(
          `SELECT 1
           FROM control_artifacts AS artifact
           WHERE artifact.task_id = $1
             AND artifact.plan_version_id = $2
             AND artifact.attempt_id = $3
             AND (
               artifact.state = 'STAGING'
               OR (
                 artifact.state = 'FAILED'
                 AND POSITION($4 IN COALESCE(artifact.failure_reason, '')) > 0
               )
               OR (
                 artifact.state = 'SEALED'
                 AND (
                   artifact.kind IN (
                     'evidence_manifest', 'deliverable', 'report_review', 'report_document', 'report_package',
                     'report_editorial_showcase_spec', 'editorial_showcase_html',
                     'cross_skill_review', 'contribution_ledger', 'contribution_summary',
                     'research_contribution_bundle',
                     'visual_asset', 'visual_asset_manifest', 'image_annotation', 'chart_spec', 'chart_data'
                   )
                   OR (
                     artifact.kind IN ('knowledge_output', 'tool_output', 'skill_output', 'research_contribution', 'llm_output', 'review_output')
                     AND NOT EXISTS (
                       SELECT 1
                       FROM control_execution_steps AS step
                       WHERE step.attempt_id = artifact.attempt_id
                         AND step.state = 'succeeded'
                         AND (
                           step.output_artifact_id = artifact.id
                           OR step.skill_provenance->>'sourceArtifactId' = artifact.id::text
                         )
                     )
                   )
                 )
               )
             )
           LIMIT 1`,
          [input.taskId, planVersionId, input.attemptId, ARTIFACT_QUARANTINE_PENDING_MARKER],
        );
        if (residualArtifacts.rows[0]) return null;
      }
      const transitioned = await connection.query(
        `UPDATE control_tasks
         SET state = 'ready', state_version = state_version + 1, updated_at = now()
         WHERE id = $1
           AND state = 'paused'
           AND state_version = $2
           AND current_attempt_id = $3
           AND active_plan_version_id = $4
         RETURNING id, state, state_version, active_plan_version_id, current_attempt_id`,
        [input.taskId, input.expectedVersion, input.attemptId, planVersionId],
      );
      const row = transitioned.rows[0];
      if (!row) {
        throw new ControlPlaneConflictError(
          `task ${input.taskId} cannot retry attempt ${input.attemptId}`,
        );
      }
      return {
        id: asString(row.id, 'id'),
        state: asString(row.state, 'state') as ControlTaskState,
        stateVersion: asNumber(row.state_version, 'state_version'),
        activePlanVersionId: typeof row.active_plan_version_id === 'string' ? row.active_plan_version_id : null,
        currentAttemptId: typeof row.current_attempt_id === 'string' ? row.current_attempt_id : null,
      };
    });
  }

  async cancelExecution(input: {
    taskId: string;
    attemptId: string;
    expectedVersion: number;
    command?: {
      idempotencyKey: string;
      requestHash: string;
      actorUserId?: string;
    };
  }): Promise<ControlTask> {
    return this.transaction(async (connection) => {
      const activeStates = ['executing', 'reviewing', 'composing_report', 'paused'];
      const lockedTask = await connection.query(
        `SELECT state FROM control_tasks
         WHERE id = $1 AND state = ANY($2::text[]) AND state_version = $3 AND current_attempt_id = $4
         FOR UPDATE`,
        [input.taskId, activeStates, input.expectedVersion, input.attemptId],
      );
      if (!lockedTask.rows[0]) {
        throw new ControlPlaneConflictError(`task ${input.taskId} cannot cancel attempt ${input.attemptId}`);
      }
      const attempt = await connection.query(
        `UPDATE control_execution_attempts
         SET state = 'cancelled', finished_at = COALESCE(finished_at, now()), lease_expires_at = now()
         WHERE id = $1 AND task_id = $2 AND state IN ('active', 'paused')
         RETURNING id`,
        [input.attemptId, input.taskId],
      );
      if (!attempt.rows[0]) throw new ControlPlaneConflictError(`attempt ${input.attemptId} is not cancellable`);
      const task = await connection.query(
        `UPDATE control_tasks
         SET state = 'cancelled', state_version = state_version + 1, updated_at = now()
         WHERE id = $1 AND state = ANY($2::text[]) AND state_version = $3 AND current_attempt_id = $4
         RETURNING id, state, state_version, active_plan_version_id, current_attempt_id`,
        [input.taskId, activeStates, input.expectedVersion, input.attemptId],
      );
      const row = task.rows[0];
      if (!row) throw new ControlPlaneConflictError(`task ${input.taskId} cannot cancel attempt ${input.attemptId}`);
      const transitioned = {
        id: asString(row.id, 'id'),
        state: asString(row.state, 'state') as ControlTaskState,
        stateVersion: asNumber(row.state_version, 'state_version'),
        activePlanVersionId: typeof row.active_plan_version_id === 'string' ? row.active_plan_version_id : null,
        currentAttemptId: typeof row.current_attempt_id === 'string' ? row.current_attempt_id : null,
      };
      if (input.command) {
        await connection.query(
          `INSERT INTO control_commands
           (task_id, command_type, idempotency_key, request_hash, expected_version,
            state_before, state_after, response_json, actor_user_id)
           VALUES ($1, 'cancel', $2, $3, $4, $5, $6, $7, $8)`,
          [
            input.taskId,
            input.command.idempotencyKey,
            input.command.requestHash,
            input.expectedVersion,
            asString(lockedTask.rows[0].state, 'state') as ControlTaskState,
            transitioned.state,
            JSON.stringify({ state: transitioned.state, stateVersion: transitioned.stateVersion }),
            input.command.actorUserId ?? null,
          ],
        );
      }
      return transitioned;
    });
  }

  async cancelPausedExecution(input: {
    taskId: string;
    attemptId: string;
    expectedVersion: number;
  }): Promise<ControlTask> {
    return this.transaction(async (connection) => {
      const lockedTask = await connection.query(
        `SELECT 1 FROM control_tasks
         WHERE id = $1 AND state = 'paused' AND state_version = $2 AND current_attempt_id = $3
         FOR UPDATE`,
        [input.taskId, input.expectedVersion, input.attemptId],
      );
      if (!lockedTask.rows[0]) {
        throw new ControlPlaneConflictError(`task ${input.taskId} cannot cancel attempt ${input.attemptId}`);
      }
      const attempt = await connection.query(
        `UPDATE control_execution_attempts
         SET state = 'cancelled', finished_at = COALESCE(finished_at, now())
         WHERE id = $1 AND task_id = $2 AND state = 'paused'
         RETURNING id`,
        [input.attemptId, input.taskId],
      );
      if (!attempt.rows[0]) throw new ControlPlaneConflictError(`attempt ${input.attemptId} is not paused`);
      const task = await connection.query(
        `UPDATE control_tasks
         SET state = 'cancelled', state_version = state_version + 1, updated_at = now()
         WHERE id = $1 AND state = 'paused' AND state_version = $2 AND current_attempt_id = $3
         RETURNING id, state, state_version, active_plan_version_id, current_attempt_id`,
        [input.taskId, input.expectedVersion, input.attemptId],
      );
      const row = task.rows[0];
      if (!row) throw new ControlPlaneConflictError(`task ${input.taskId} cannot cancel attempt ${input.attemptId}`);
      return {
        id: asString(row.id, 'id'),
        state: asString(row.state, 'state') as ControlTaskState,
        stateVersion: asNumber(row.state_version, 'state_version'),
        activePlanVersionId: typeof row.active_plan_version_id === 'string' ? row.active_plan_version_id : null,
        currentAttemptId: typeof row.current_attempt_id === 'string' ? row.current_attempt_id : null,
      };
    });
  }

  async createZeroPublication(input: {
    taskId: string;
    ownerUserId: string;
    planVersionId: string;
    attemptId: string;
    reportPackageArtifactId: string;
    reportPackageHash: string;
    idempotencyKey: string;
    requestHash: string;
    templateVersion: string;
    zeroFileKey?: string;
    zeroPageId: string;
    zeroPageName: string;
    updatePublicationId?: string;
  }): Promise<ControlZeroPublication> {
    return this.transaction(async (connection) => {
      const taskResult = await connection.query(
        `SELECT task.state, task.owner_user_id,
                conversation.owner_user_id AS conversation_owner_user_id,
                task.active_plan_version_id, task.current_attempt_id
         FROM control_tasks AS task
         JOIN conversations AS conversation ON conversation.id = task.conversation_id
         WHERE task.id = $1
         FOR SHARE OF task`,
        [input.taskId],
      );
      const task = taskResult.rows[0];
      if (
        !task
        || task.owner_user_id !== input.ownerUserId
        || task.conversation_owner_user_id !== input.ownerUserId
      ) {
        throw new ControlPlaneAuthorizationError('Zero publication task is not owned by requester');
      }
      if (task.state !== 'completed' && task.state !== 'completed_with_gaps') {
        throw new ControlPlaneConflictError(`task ${input.taskId} is not completed`);
      }
      if (
        task.active_plan_version_id !== input.planVersionId
        || task.current_attempt_id !== input.attemptId
      ) {
        throw new ControlPlaneConflictError('Zero publication binding does not match the completed task');
      }

      const packageResult = await connection.query(
        `SELECT artifact.content_sha256
         FROM control_artifacts AS artifact
         WHERE artifact.id = $1
           AND artifact.task_id = $2
           AND artifact.plan_version_id = $3
           AND artifact.attempt_id = $4
           AND artifact.kind = 'report_package'
           AND artifact.schema_version IN ('report-package-v1', 'report-package-v2', 'report-package-v3')
           AND artifact.state = 'SEALED'
         FOR SHARE`,
        [
          input.reportPackageArtifactId,
          input.taskId,
          input.planVersionId,
          input.attemptId,
        ],
      );
      if (packageResult.rows[0]?.content_sha256 !== input.reportPackageHash) {
        throw new ControlPlaneConflictError('Zero publication Report Package is not verified');
      }

      let updateRootNodeId: string | null = null;
      if (input.updatePublicationId) {
        const previous = await connection.query(
          `SELECT final_root_node_id, zero_file_key, zero_page_id
           FROM control_zero_publications
           WHERE id = $1
             AND task_id = $2
             AND owner_user_id = $3
             AND status = 'completed'
           FOR SHARE`,
          [input.updatePublicationId, input.taskId, input.ownerUserId],
        );
        const row = previous.rows[0];
        if (
          !row
          || typeof row.final_root_node_id !== 'string'
          || row.zero_page_id !== input.zeroPageId
          || (row.zero_file_key ?? null) !== (input.zeroFileKey ?? null)
        ) {
          throw new ControlPlaneConflictError('Zero update publication is not a completed compatible target');
        }
        updateRootNodeId = row.final_root_node_id;
      }

      const inserted = await connection.query(
        `INSERT INTO control_zero_publications
           (task_id, owner_user_id, plan_version_id, attempt_id,
            report_package_artifact_id, report_package_hash,
            idempotency_key, request_hash, template_version,
            status, stage, progress, zero_file_key, zero_page_id, zero_page_name,
            update_publication_id, update_root_node_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                 'queued', 'checking_zero', 0, $10, $11, $12, $13, $14)
         ON CONFLICT (task_id, idempotency_key) DO NOTHING
         RETURNING *`,
        [
          input.taskId,
          input.ownerUserId,
          input.planVersionId,
          input.attemptId,
          input.reportPackageArtifactId,
          input.reportPackageHash,
          input.idempotencyKey,
          input.requestHash,
          input.templateVersion,
          input.zeroFileKey ?? null,
          input.zeroPageId,
          input.zeroPageName,
          input.updatePublicationId ?? null,
          updateRootNodeId,
        ],
      );
      if (inserted.rows[0]) return zeroPublicationFromRow(inserted.rows[0]);
      const existing = await connection.query(
        `SELECT * FROM control_zero_publications
         WHERE task_id = $1 AND idempotency_key = $2
         FOR UPDATE`,
        [input.taskId, input.idempotencyKey],
      );
      const row = existing.rows[0];
      if (
        !row
        || row.owner_user_id !== input.ownerUserId
        || row.request_hash !== input.requestHash
      ) {
        throw new ControlPlaneConflictError(
          `Zero publication idempotency key ${input.idempotencyKey} conflicts`,
        );
      }
      if (row.status !== 'failed') return zeroPublicationFromRow(row);
      const retried = await connection.query(
        `UPDATE control_zero_publications
         SET status = 'queued', stage = 'checking_zero', progress = 0,
             failure_json = NULL, lease_owner = NULL, lease_expires_at = NULL,
             completed_at = NULL, updated_at = now()
         WHERE id = $1 AND status = 'failed'
         RETURNING *`,
        [row.id],
      );
      if (!retried.rows[0]) {
        throw new ControlPlaneConflictError(`Zero publication ${row.id} cannot retry`);
      }
      return zeroPublicationFromRow(retried.rows[0]);
    });
  }

  async getZeroPublicationByIdForOwner(input: {
    publicationId: string;
    ownerUserId: string;
  }): Promise<ControlZeroPublication | null> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        `SELECT publication.*
         FROM control_zero_publications AS publication
         JOIN control_tasks AS task ON task.id = publication.task_id
         JOIN conversations AS conversation ON conversation.id = task.conversation_id
         WHERE publication.id = $1
           AND publication.owner_user_id = $2
           AND task.owner_user_id = $2
           AND conversation.owner_user_id = $2`,
        [input.publicationId, input.ownerUserId],
      );
      return result.rows[0] ? zeroPublicationFromRow(result.rows[0]) : null;
    } finally {
      connection.release();
    }
  }

  async getZeroPublicationForOwner(input: {
    publicationId: string;
    taskId: string;
    ownerUserId: string;
  }): Promise<ControlZeroPublication | null> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        `SELECT publication.*
         FROM control_zero_publications AS publication
         JOIN control_tasks AS task ON task.id = publication.task_id
         JOIN conversations AS conversation ON conversation.id = task.conversation_id
         WHERE publication.id = $1
           AND publication.task_id = $2
           AND publication.owner_user_id = $3
           AND task.owner_user_id = $3
           AND conversation.owner_user_id = $3`,
        [input.publicationId, input.taskId, input.ownerUserId],
      );
      return result.rows[0] ? zeroPublicationFromRow(result.rows[0]) : null;
    } finally {
      connection.release();
    }
  }

  async claimZeroPublication(input: {
    publicationId: string;
    leaseOwner: string;
    leaseExpiresAt: Date;
  }): Promise<ControlZeroPublication | null> {
    return this.transaction(async (connection) => {
      const result = await connection.query(
        `UPDATE control_zero_publications
         SET status = 'running', failure_json = NULL, completed_at = NULL,
             lease_owner = $2, lease_expires_at = $3,
             updated_at = now()
         WHERE id = $1
           AND (
             status = 'queued'
             OR (status = 'running' AND lease_expires_at <= now())
           )
         RETURNING *`,
        [input.publicationId, input.leaseOwner, input.leaseExpiresAt],
      );
      return result.rows[0] ? zeroPublicationFromRow(result.rows[0]) : null;
    });
  }

  async heartbeatZeroPublication(input: {
    publicationId: string;
    leaseOwner: string;
    extendUntil: Date;
  }): Promise<ControlZeroPublication> {
    return this.transaction(async (connection) => {
      const result = await connection.query(
        `UPDATE control_zero_publications
         SET lease_expires_at = GREATEST(lease_expires_at, $3), updated_at = now()
         WHERE id = $1
           AND status = 'running'
           AND lease_owner = $2
           AND lease_expires_at > now()
         RETURNING *`,
        [input.publicationId, input.leaseOwner, input.extendUntil],
      );
      if (!result.rows[0]) {
        throw new ControlPlaneConflictError(`Zero publication lease ${input.publicationId} is not active`);
      }
      return zeroPublicationFromRow(result.rows[0]);
    });
  }

  async updateZeroPublication(input: {
    publicationId: string;
    leaseOwner: string;
    stage: ZeroPublicationStage;
    progress: number;
    draftRootNodeId?: string;
    zeroNodeMap?: Record<string, unknown>;
    imageManifest?: unknown[];
    screenshotManifest?: unknown[];
    receiptArtifactId?: string;
  }): Promise<ControlZeroPublication> {
    return this.transaction(async (connection) => {
      const result = await connection.query(
        `UPDATE control_zero_publications
         SET stage = $3,
             progress = $4,
             draft_root_node_id = COALESCE($5, draft_root_node_id),
             zero_node_map = COALESCE($6::jsonb, zero_node_map),
             image_manifest = COALESCE($7::jsonb, image_manifest),
             screenshot_manifest = COALESCE($8::jsonb, screenshot_manifest),
             receipt_artifact_id = COALESCE($9, receipt_artifact_id),
             updated_at = now()
         WHERE id = $1
           AND status = 'running'
           AND lease_owner = $2
           AND lease_expires_at > now()
         RETURNING *`,
        [
          input.publicationId,
          input.leaseOwner,
          input.stage,
          input.progress,
          input.draftRootNodeId ?? null,
          input.zeroNodeMap === undefined ? null : JSON.stringify(input.zeroNodeMap),
          input.imageManifest === undefined ? null : JSON.stringify(input.imageManifest),
          input.screenshotManifest === undefined ? null : JSON.stringify(input.screenshotManifest),
          input.receiptArtifactId ?? null,
        ],
      );
      if (!result.rows[0]) {
        throw new ControlPlaneConflictError(`Zero publication lease ${input.publicationId} cannot update`);
      }
      return zeroPublicationFromRow(result.rows[0]);
    });
  }

  async completeZeroPublication(input: {
    publicationId: string;
    leaseOwner: string;
    finalRootNodeId: string;
    receiptArtifactId: string;
    screenshotManifest: unknown[];
  }): Promise<ControlZeroPublication> {
    return this.transaction(async (connection) => {
      const publicationResult = await connection.query(
        `SELECT task_id, plan_version_id, attempt_id
         FROM control_zero_publications
         WHERE id = $1
           AND status = 'running'
           AND lease_owner = $2
           AND lease_expires_at > now()
         FOR UPDATE`,
        [input.publicationId, input.leaseOwner],
      );
      const publication = publicationResult.rows[0];
      if (!publication) {
        throw new ControlPlaneConflictError(`Zero publication lease ${input.publicationId} cannot complete`);
      }
      const receipt = await connection.query(
        `SELECT 1 FROM control_artifacts
         WHERE id = $1
           AND task_id = $2
           AND plan_version_id = $3
           AND attempt_id IS NULL
           AND kind = 'zero_publication_receipt'
           AND schema_version = 'zero-publication-receipt-v1'
           AND state = 'SEALED'
         FOR SHARE`,
        [
          input.receiptArtifactId,
          publication.task_id,
          publication.plan_version_id,
        ],
      );
      if (!receipt.rows[0]) {
        throw new ControlPlaneConflictError('Zero publication receipt Artifact is not verified');
      }
      const result = await connection.query(
        `UPDATE control_zero_publications
         SET status = 'completed', stage = 'finalizing_receipt', progress = 100,
             final_root_node_id = $3, receipt_artifact_id = $4,
             screenshot_manifest = $5::jsonb,
             lease_owner = NULL, lease_expires_at = NULL,
             completed_at = now(), updated_at = now()
         WHERE id = $1 AND status = 'running' AND lease_owner = $2
         RETURNING *`,
        [
          input.publicationId,
          input.leaseOwner,
          input.finalRootNodeId,
          input.receiptArtifactId,
          JSON.stringify(input.screenshotManifest),
        ],
      );
      if (!result.rows[0]) {
        throw new ControlPlaneConflictError(`Zero publication ${input.publicationId} cannot complete`);
      }
      return zeroPublicationFromRow(result.rows[0]);
    });
  }

  async failZeroPublication(input: {
    publicationId: string;
    leaseOwner?: string;
    failure: ZeroPublicationFailure;
  }): Promise<ControlZeroPublication> {
    return this.transaction(async (connection) => {
      const result = await connection.query(
        `UPDATE control_zero_publications
         SET status = 'failed', failure_json = $3::jsonb,
             lease_owner = NULL, lease_expires_at = NULL,
             completed_at = now(), updated_at = now()
         WHERE id = $1
           AND status IN ('queued', 'running')
           AND (
             ($2::text IS NULL AND lease_owner IS NULL)
             OR lease_owner = $2
           )
         RETURNING *`,
        [input.publicationId, input.leaseOwner ?? null, JSON.stringify(input.failure)],
      );
      if (!result.rows[0]) {
        throw new ControlPlaneConflictError(`Zero publication ${input.publicationId} cannot fail`);
      }
      return zeroPublicationFromRow(result.rows[0]);
    });
  }

  async listExpiredZeroPublications(input: { limit: number }): Promise<ControlZeroPublication[]> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        `SELECT * FROM control_zero_publications
         WHERE status = 'running' AND lease_expires_at <= now()
         ORDER BY lease_expires_at, id
         LIMIT $1`,
        [Math.min(Math.max(input.limit, 1), 100)],
      );
      return result.rows.map(zeroPublicationFromRow);
    } finally {
      connection.release();
    }
  }

  async pauseExecution(input: { taskId: string; attemptId: string; expectedVersion: number; reason: string }): Promise<ControlTask> {
    return this.transaction(async (connection) => {
      const lockedTask = await connection.query(
        `SELECT 1 FROM control_tasks
         WHERE id = $1 AND state_version = $2
           AND state IN ('executing', 'reviewing', 'composing_report')
           AND current_attempt_id = $3
         FOR UPDATE`,
        [input.taskId, input.expectedVersion, input.attemptId],
      );
      if (!lockedTask.rows[0]) {
        throw new ControlPlaneConflictError(`task ${input.taskId} is no longer executing at version ${input.expectedVersion}`);
      }
      const attempt = await connection.query(
        `UPDATE control_execution_attempts SET state = 'paused', failure_kind = $3, finished_at = now()
         WHERE id = $1 AND task_id = $2 AND state = 'active' RETURNING id`,
        [input.attemptId, input.taskId, input.reason],
      );
      if (!attempt.rows[0]) throw new ControlPlaneConflictError(`attempt ${input.attemptId} is not active`);
      const task = await connection.query(
        `UPDATE control_tasks SET state = 'paused', state_version = state_version + 1, updated_at = now()
         WHERE id = $1 AND state_version = $2
           AND state IN ('executing', 'reviewing', 'composing_report')
           AND current_attempt_id = $3
         RETURNING id, state, state_version, active_plan_version_id, current_attempt_id`,
        [input.taskId, input.expectedVersion, input.attemptId],
      );
      const row = task.rows[0];
      if (!row) throw new ControlPlaneConflictError(`task ${input.taskId} is no longer executing at version ${input.expectedVersion}`);
      return {
        id: asString(row.id, 'id'),
        state: asString(row.state, 'state') as ControlTaskState,
        stateVersion: asNumber(row.state_version, 'state_version'),
        activePlanVersionId: typeof row.active_plan_version_id === 'string' ? row.active_plan_version_id : null,
        currentAttemptId: typeof row.current_attempt_id === 'string' ? row.current_attempt_id : null,
      };
    });
  }
}
