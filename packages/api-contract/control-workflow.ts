import type {
  ReadableExecutionPlan,
  ResolvedPlanInputs,
} from './native-skill-orchestration.ts';
import type { CandidateProfile, ResearchTaskData, ResearchTaskV2 } from './plan.ts';
import type {
  ContributionLedgerV1,
  ContributionSummaryV1,
  CrossSkillReviewV1,
  CurrentExecutionPlanV3,
  EvidenceManifest,
  LegacyResearchDeliverableEnvelope,
  PendingInput,
  ResearchDeliverableEnvelope,
  VisualAssetManifest,
} from './research-deliverable.ts';
import type { ReadableReportDocument } from './report-document.ts';
import type { ReportPackageV2, ReportPackageV3 } from './report-package.ts';

export type ControlWorkflowState =
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

export type ControlWorkflowRole = 'owner' | 'legal' | 'security' | 'gold';

export const ORCHESTRATION_MODES = ['single_skill', 'multi_skill'] as const;
export type OrchestrationModeV1 = typeof ORCHESTRATION_MODES[number];

export function isOrchestrationModeV1(value: unknown): value is OrchestrationModeV1 {
  return typeof value === 'string'
    && (ORCHESTRATION_MODES as readonly string[]).includes(value);
}

export interface PlanningGuidanceClarification {
  reasonCode: 'scenario_selection_required';
  options: Array<{ id: string; label: string }>;
}

export interface ControlRequirementVersion {
  id: string;
  taskId: string;
  version: number;
  rawInputHash: string;
  clarification: unknown;
  structuredTask: ResearchTaskV2;
  modelCallId: string | null;
  createdAt: Date;
}

export interface CreateRequirementVersionRequest {
  taskId: string;
  version: number;
  rawInputHash: string;
  clarification: unknown;
  structuredTask: ResearchTaskV2;
  modelCallId?: string | null;
}

export interface ActivateRequirementVersionRequest {
  taskId: string;
  requirementVersionId: string;
  expectedVersion: number;
  ownerUserId: string;
}
export interface PlanControlTaskRequest {
  originalInput: string;
  conversationId?: string;
  orchestrationMode: OrchestrationModeV1;
}


export interface ControlTaskResponse {
  id: string;
  state: ControlWorkflowState;
  stateVersion: number;
  activePlanVersionId: string | null;
  currentAttemptId: string | null;
  orchestrationMode?: OrchestrationModeV1 | null;
}

export interface ControlTaskStatusResponse {
  taskId: string;
  state: ControlWorkflowState;
  stateVersion: number;
  currentAttemptId: string | null;
  executionSteps: Array<{
    stepNo: number;
    state: string;
    startedAt: string | null;
    finishedAt: string | null;
  }>;
}

export interface CreateControlTaskRequest {
  originalInput: string;
  taskType?: string;
  structuredTask?: Record<string, unknown>;
  sensitivity?: string;
}

export interface CurrentPlanCandidate {
  planVersionId: string;
  candidateId: CandidateProfile;
  title: string;
  rationale: string;
  tradeoffs: string;
  planHash: string;
  plan: ReadableExecutionPlan;
  pendingInputs: PendingInput[];
  resolvedInputs?: ResolvedPlanInputs;
}

export interface CurrentPlanCandidateV3 extends Omit<CurrentPlanCandidate, 'plan'> {
  plan: CurrentExecutionPlanV3;
}

export type ReadableCurrentPlanCandidate = CurrentPlanCandidate;

export interface ControlPlanCandidatesResponse {
  kind: 'current';
  conversationId: string;
  task: ControlTaskResponse;
  structuredTask: ResearchTaskData | ResearchTaskV2;
  activatedNodes: string[];
  candidates: CurrentPlanCandidate[];
}

export interface SelectControlPlanRequest {
  expectedVersion: number;
  planVersionId: string;
  idempotencyKey: string;
}

export interface SelectControlPlanResponse {
  planVersionId: string;
  state: ControlWorkflowState;
  stateVersion: number;
}

export interface ReviseControlPlanRequest {
  expectedVersion: number;
  revisionInstruction: string;
  idempotencyKey: string;
}

export interface ReviseControlPlanResponse {
  planVersionId: string;
  state: ControlWorkflowState;
  stateVersion: number;
}

export interface ConfirmControlPlanRequest {
  expectedVersion: number;
  planVersionId: string;
  confirmationAnswers: Record<string, unknown>;
  inputValues: Record<string, unknown>;
  waivedInputKeys?: string[];
  idempotencyKey: string;
}

export interface ApprovalControlPlanRequest {
  expectedVersion: number;
  planVersionId: string;
  gateKey: string;
  decision: 'approved' | 'rejected';
  idempotencyKey: string;
}

export interface ExecutionControlPlanRequest {
  expectedVersion: number;
  planVersionId: string;
  idempotencyKey: string;
}

export interface CancelControlPlanRequest {
  expectedVersion: number;
  idempotencyKey: string;
}

export interface ResumeControlPlanRequest {
  expectedVersion: number;
  idempotencyKey: string;
  action?: 'retry' | 'skip' | 'abort';
  failedStepNo?: number;
}

export interface ControlCommandResponse {
  state: ControlWorkflowState;
  stateVersion: number;
}

export const TASK_FOLLOW_UP_MESSAGE_VERSION = 'task-follow-up-message-v1' as const;

export interface TaskFollowUpMessageV1 {
  version: typeof TASK_FOLLOW_UP_MESSAGE_VERSION;
  id: string;
  taskId: string;
  role: 'user' | 'assistant';
  content: string;
  sourceIds: string[];
  gaps: string[];
  createdAt: string;
}

export interface CreateTaskFollowUpRequest {
  message: string;
}

export interface TaskFollowUpResponse {
  messages: TaskFollowUpMessageV1[];
}

export interface TaskFollowUpListResponse {
  messages: TaskFollowUpMessageV1[];
}

export type ControlApprovalDecision = 'pending' | 'approved' | 'rejected';

export interface ControlApprovalRequirement {
  gateKey: string;
  requiredAuthority: ControlWorkflowRole;
  decision: ControlApprovalDecision;
  canApprove: boolean;
}

export interface ControlApprovalTaskSummary {
  id: string;
  originalInput: string;
  taskType: string | null;
  state: ControlWorkflowState;
  stateVersion: number;
  activePlanVersionId: string | null;
}

export interface ControlPlanRecovery {
  kind: 'plan_revision_required';
  reason: 'legacy_pending_inputs';
}

export interface DisabledExecutionResponse extends ControlCommandResponse {
  attemptId: string;
  executionDisabled: true;
}
export interface ControlExecutionResult {
  attemptId: string;
  state: ControlWorkflowState;
  stateVersion: number;
  status: 'completed' | 'completed_with_gaps' | 'paused';
  executionDisabled: false;
  deliverableArtifactId?: string;
  evidenceManifestArtifactId?: string;
  reportReviewArtifactId?: string;
  reportPackageArtifactId?: string;
  finalReportArtifactId?: string;
  crossSkillReviewArtifactId?: string;
  contributionLedgerArtifactId?: string;
  contributionSummaryArtifactId?: string;
  reviewStatus?: 'completed' | 'paused';
  gapCount?: number;
  failedStepNo?: number;
  failure?: Record<string, unknown>;
}

export type ReportReviewVerdict = 'pass' | 'revise' | 'block';
export const REPORT_REVIEW_DIMENSION_IDS = [
  'requirement_coverage',
  'question_coverage',
  'evidence_coverage',
  'reasoning_quality',
  'recommendation_quality',
  'visual_quality',
  'risk_disclosure',
] as const;
export const ANSWER_QUALITY_REVIEW_DIMENSION_IDS = [
  'direct_answer_coverage',
  'requested_artifact_presence',
  'answer_evidence_strength',
  'decision_usefulness',
  'hypothesis_conclusion_clarity',
  'risk_consistency',
] as const;
export const REPORT_REVIEW_V2_DIMENSION_IDS = [
  ...REPORT_REVIEW_DIMENSION_IDS,
  ...ANSWER_QUALITY_REVIEW_DIMENSION_IDS,
] as const;
export const INDUSTRY_REPORT_REVIEW_DIMENSION_IDS = [
  'requirement_coverage',
  'question_coverage',
  'ten_dimension_coverage',
  'evidence_coverage',
  'market_claim_strength',
  'persona_evidence_boundary',
  'competitor_sample_integrity',
  'jd_diagnosis_quality',
  'category_specificity',
  'strategy_chain_actionability',
  'category_asset_provenance',
  'measurement_quality',
  'risk_disclosure',
  'visual_quality',
] as const;
export type ReportReviewDimensionId =
  | typeof REPORT_REVIEW_V2_DIMENSION_IDS[number]
  | typeof INDUSTRY_REPORT_REVIEW_DIMENSION_IDS[number];

export interface ReportReviewIssue {
  id: string;
  message: string;
  targetNodeIds: string[];
}

export interface ReportReviewDimension {
  id: ReportReviewDimensionId;
  passed: boolean;
  issues: string[];
  targetNodeIds?: string[];
  revisionIssues?: ReportReviewIssue[];
}

export interface ReportReviewArtifact {
  version: 'report-review-v1' | 'report-review-v2' | 'report-review-v3';
  taskId: string;
  planVersionId: string;
  attemptId: string;
  deliverableArtifactId: string;
  verdict: ReportReviewVerdict;
  dimensions: ReportReviewDimension[];
  revisionRound: 0 | 1;
}

export type PassedReportReviewArtifact = ReportReviewArtifact & { verdict: 'pass' };

interface CoreReportPackageResponse<TDeliverable> {
  deliverable: TDeliverable;
  evidenceManifest: EvidenceManifest;
  crossSkillReview?: CrossSkillReviewV1;
  contributionLedger?: ContributionLedgerV1;
  contributionSummary?: ContributionSummaryV1;
}

export type CurrentReportPackageV2Metadata = Pick<
  ReportPackageV2,
  | 'version'
  | 'reportPublicationId'
  | 'layout'
  | 'assetSnapshot'
  | 'standaloneHtml'
  | 'notices'
>;

export type CurrentReportPackageV3Metadata = ReportPackageV3;

export type CurrentReportPackageResponse<TPayload = unknown> =
  | CoreReportPackageResponse<LegacyResearchDeliverableEnvelope<TPayload>> & {
      presentationMode: 'legacy_text';
      reportReview?: never;
      reportDocument?: never;
      visualAssetManifests?: never;
    }
  | CoreReportPackageResponse<ResearchDeliverableEnvelope<TPayload>> & {
      presentationMode: 'current_text';
      reportReview: PassedReportReviewArtifact;
      reportDocument?: never;
      visualAssetManifests?: never;
    }
  | CoreReportPackageResponse<ResearchDeliverableEnvelope<TPayload>> & {
      presentationMode: 'multimodal';
      reportReview: PassedReportReviewArtifact;
      reportDocument: ReadableReportDocument;
      reportDocumentContentSha256: string;
      visualAssetManifests: VisualAssetManifest[];
      reportPackage?: CurrentReportPackageV2Metadata;
      editorialShowcase?: CurrentReportPackageV3Metadata;
    };


export interface LegacyTaskReadResponse<T> {
  kind: 'legacy';
  task: T;
}

export interface ControlExecutionStepResponse {
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
}

type FailedExecutionStep = Pick<ControlExecutionStepResponse, 'stepNo' | 'state' | 'failure'>;

function failureAuthority(failure: Record<string, unknown> | null | undefined): number {
  if (failure?.kind === 'artifact_invalidation') return 2;
  if (failure?.kind === 'worker_loss') return 1;
  return 0;
}

export function executionFailureAllowsAction(
  failure: Record<string, unknown> | null | undefined,
  action: string,
): boolean {
  if (action === 'retry' && failure?.kind === 'deliverable_validation') return true;
  return Array.isArray(failure?.allowedActions) && failure.allowedActions.includes(action);
}

export function selectAuthoritativeFailedStep<T extends FailedExecutionStep>(
  steps: readonly T[],
): T | undefined {
  let selected: T | undefined;
  let selectedAuthority = -1;
  for (const step of steps) {
    if (step.state !== 'failed') continue;
    const authority = failureAuthority(step.failure);
    if (
      !selected
      || authority > selectedAuthority
      || (
        authority === selectedAuthority
        && (authority === 2 ? step.stepNo < selected.stepNo : step.stepNo > selected.stepNo)
      )
    ) {
      selected = step;
      selectedAuthority = authority;
    }
  }
  return selected;
}

export interface CurrentTaskReadResponse {
  kind: 'current';
  task: ControlTaskResponse & {
    conversationId: string;
    originalInput: string;
    structuredTask: ResearchTaskData | ResearchTaskV2;
  };
  executionSteps: ControlExecutionStepResponse[];
  activatedNodes: string[];
  candidates: CurrentPlanCandidate[];
  activePlan: CurrentPlanCandidate | null;
  planningGuidance?: PlanningGuidanceClarification;
  approvalRequirements?: ControlApprovalRequirement[];
  planRecovery?: ControlPlanRecovery;
}
