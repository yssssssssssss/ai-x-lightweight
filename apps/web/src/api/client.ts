// API client:fetch 封装 + JWT header + 错误处理。
// 与 agent-api 契约对齐(见 apps/agent-api/src/routes/*)。

const TOKEN_KEY = 'ur_token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(t: string): void {
  localStorage.setItem(TOKEN_KEY, t);
}
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

async function req<T>(path: string, opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...opts.headers };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(
      res.status,
      data?.error ?? `HTTP ${res.status}`,
      typeof data?.code === 'string' ? data.code : undefined,
    );
  }
  return data as T;
}

async function reqForm<T>(path: string, form: FormData, idempotencyKey: string): Promise<T> {
  const headers: Record<string, string> = { 'Idempotency-Key': idempotencyKey };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`/api${path}`, { method: 'POST', headers, body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(
      res.status,
      data?.error ?? `HTTP ${res.status}`,
      typeof data?.code === 'string' ? data.code : undefined,
    );
  }
  return data as T;
}

async function reqBlob(path: string): Promise<Response> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`/api${path}`, { headers });
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { error?: string; code?: string };
    throw new ApiError(
      response.status,
      data.error ?? `HTTP ${response.status}`,
      typeof data.code === 'string' ? data.code : undefined,
    );
  }
  return response;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
  }
}

export interface DatasetUpload {
  role: string;
  file: File;
  metadata: DatasetUploadMetadata;
}

export interface DocumentUpload {
  role: string;
  files: File[];
}

export interface VisualUpload {
  role: string;
  files: File[];
}

// ---- 类型 ----
// 契约类型集中在 packages/api-contract(前后端共享同一份,漂移编译期即炸)。
// 这里 re-export,让前端各组件的 import 路径('./api/client.ts')保持不变。
export type {
  CandidateProfile,
  PlanningProvenance,
  Assumption,
  PlanStep,
  ResearchTaskData,
  ResearchTaskV2,
  PendingUpload,
  PlanCandidate,
  PlanPhaseKey,
  PlanProgress,
} from '../../../../packages/api-contract/plan.ts';
export type {
  User,
  DatasetUploadMetadata,
  DatasetUploadResponse,
  DocumentUploadResponse,
  VisualUploadResponse,
  Finding,
  Report,
  ExecLogRow,
  FinalizedPlan,
  PlanCandidatesResponse,
  SelectResponse,
  PlanResponse,
  ExecuteResponse,
  TaskDetail,
  TaskSummary,
  TaskHistoryKind,
  TaskHistoryPreference,
  TaskHistoryPreferencePatch,
  SkillItem,
} from '../../../../packages/api-contract/http.ts';

import type {
  DatasetUploadMetadata,
  DatasetUploadResponse,
  DocumentUploadResponse,
  VisualUploadResponse,
} from '../../../../packages/api-contract/http.ts';
import type {
  CurrentPlanningResponse,
} from '../../../agent-api/src/routes/control-planning.ts';

export type {
  ApprovalControlPlanRequest,
  CancelControlPlanRequest,
  ControlApprovalRequirement,
  ControlApprovalTaskSummary,
  ControlPlanRecovery,
  ConfirmControlPlanRequest,
  ControlCommandResponse,
  ControlExecutionResult,
  ControlPlanCandidatesResponse,
  ControlTaskResponse,
  ControlWorkflowState as ControlTaskState,
  CurrentTaskReadResponse,
  CurrentPlanCandidate,
  ExecutionControlPlanRequest,
  OrchestrationModeV1,
  PlanControlTaskRequest,
  ResumeControlPlanRequest,
  ReviseControlPlanRequest,
  ReviseControlPlanResponse,
  SelectControlPlanRequest,
  SelectControlPlanResponse,
} from '../../../../packages/api-contract/control-workflow.ts';
export type {
  CapabilityProvenance,
  CurrentRecommendation,
  EvidenceEntry,
  FindingGraph,
  ResearchDeliverableEnvelope,
  ResearchPlanPayload,
} from '../../../../packages/api-contract/research-deliverable.ts';
export type {
  NativeFinalReport,
  NativeSkillResult,
} from '../../../../packages/api-contract/native-skill-orchestration.ts';
export type {
  ControlFinalReport,
  HistoricalFinalReportV1,
} from '../../../../packages/api-contract/historical-final-report.ts';
export type { ClarificationRequiredResponse, CurrentPlanningResponse } from '../../../agent-api/src/routes/control-planning.ts';
export type {
  SystemCapabilitiesResponse,
} from '../../../../packages/api-contract/system-capabilities.ts';
export type {
  ZeroIntegrationStatusResponse,
  ZeroPublicationResponse,
  ZeroPublicationStage,
  ZeroPublicationStatus,
} from '../../../../packages/api-contract/zero-publication.ts';

import type {
  ApprovalControlPlanRequest,
  CancelControlPlanRequest,
  ControlApprovalTaskSummary,
  ConfirmControlPlanRequest,
  ControlCommandResponse,
  ControlExecutionResult,
  CurrentTaskReadResponse,
  ExecutionControlPlanRequest,
  PlanControlTaskRequest,
  ResumeControlPlanRequest,
  ReviseControlPlanRequest,
  ReviseControlPlanResponse,
  SelectControlPlanRequest,
  SelectControlPlanResponse,
} from '../../../../packages/api-contract/control-workflow.ts';
import type {
  NativeSkillResult,
} from '../../../../packages/api-contract/native-skill-orchestration.ts';
import type { ControlFinalReport } from '../../../../packages/api-contract/historical-final-report.ts';
import type { PlanProgress } from '../../../../packages/api-contract/plan.ts';
import type { VisualAssetManifest } from '../../../../packages/api-contract/research-deliverable.ts';
import type { SystemCapabilitiesResponse } from '../../../../packages/api-contract/system-capabilities.ts';
import type {
  CreateZeroPublicationRequest,
  ZeroIntegrationStatusResponse,
  ZeroPublicationResponse,
} from '../../../../packages/api-contract/zero-publication.ts';
import type {
  User,
  TaskDetail,
  TaskSummary,
  TaskHistoryKind,
  TaskHistoryPreference,
  TaskHistoryPreferencePatch,
  SkillItem,
} from '../../../../packages/api-contract/http.ts';
import { parseControlDeliverableResponse } from '../report-package-response.ts';
export type { ControlDeliverableResponse } from '../report-package-response.ts';


export interface ClarifyControlTaskRequest {
  expectedVersion: number;
  clarificationAnswers: Record<string, unknown>;
  assumptionEdits: Record<string, string>;
  selectedScenarioId?: string;
  idempotencyKey: string;
}

export interface ControlVisualAssetResponse {
  blob: Blob;
  mediaType: VisualAssetManifest['mediaType'];
}

export interface ControlHtmlBundleResponse {
  blob: Blob;
}

interface PlanningStreamHandlers {
  onConversation?: (conversationId: string) => void;
  onProgress?: (event: PlanProgress) => void;
}

async function postPlanningStream(
  path: string,
  body: unknown,
  handlers: PlanningStreamHandlers,
  requestHeaders: Record<string, string> = {},
): Promise<CurrentPlanningResponse> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...requestHeaders,
  };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`/api${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const failure = await response.json().catch(() => ({})) as { error?: unknown; code?: unknown };
    throw new ApiError(
      response.status,
      typeof failure.error === 'string' ? failure.error : `HTTP ${response.status}`,
      typeof failure.code === 'string' ? failure.code : undefined,
    );
  }
  if (!response.body) throw new ApiError(502, '规划响应缺少流式内容');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: CurrentPlanningResponse | null = null;
  const consume = (block: string): void => {
    let event = 'message';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (!data) return;
    const parsed: unknown = JSON.parse(data);
    if (event === 'conversation') {
      const conversation = parsed as { conversationId?: unknown };
      if (typeof conversation.conversationId === 'string') {
        handlers.onConversation?.(conversation.conversationId);
      }
    } else if (event === 'progress') {
      handlers.onProgress?.(parsed as PlanProgress);
    } else if (event === 'result') {
      result = parsed as CurrentPlanningResponse;
    } else if (event === 'error') {
      const failure = parsed as { error?: unknown; status?: unknown; code?: unknown };
      throw new ApiError(
        typeof failure.status === 'number' ? failure.status : 502,
        typeof failure.error === 'string' ? failure.error : '规划失败',
        typeof failure.code === 'string' ? failure.code : undefined,
      );
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer = `${buffer}${decoder.decode(value, { stream: !done })}`.replaceAll('\r\n', '\n');
      let separator = buffer.indexOf('\n\n');
      while (separator >= 0) {
        consume(buffer.slice(0, separator));
        buffer = buffer.slice(separator + 2);
        separator = buffer.indexOf('\n\n');
      }
      if (done) break;
    }
    if (buffer.trim()) consume(buffer);
  } finally {
    reader.releaseLock();
  }
  if (!result) throw new ApiError(502, '规划未返回结果');
  return result;
}

export const api = {
  systemCapabilities: () => req<SystemCapabilitiesResponse>('/system/capabilities'),
  authMethods: () => req<{ quickLogin: boolean }>('/auth/methods'),
  quickLogin: () => req<{ token: string; user: User }>('/auth/quick-login', { method: 'POST' }),
  register: (b: { email: string; password: string; displayName: string }) =>
    req<{ token: string; user: User }>('/auth/register', { method: 'POST', body: b }),
  login: (b: { email: string; password: string }) =>
    req<{ token: string; user: User }>('/auth/login', { method: 'POST', body: b }),
  me: () => req<{ user: User }>('/auth/me'),
  // Current 规划流:SSE conversation/progress/result/error 在 client 层收口。
  planControlStream: async (
    body: PlanControlTaskRequest,
    handlers: PlanningStreamHandlers = {},
  ): Promise<CurrentPlanningResponse> => postPlanningStream(
    '/control-tasks/plan/stream',
    body,
    handlers,
  ),
  clarifyControlTask: (
    taskId: string,
    body: ClarifyControlTaskRequest,
  ) => req<CurrentPlanningResponse>(`/control-tasks/${taskId}/clarify`, {
    method: 'POST',
    body,
    headers: { 'Idempotency-Key': body.idempotencyKey },
  }),
  clarifyControlTaskStream: (
    taskId: string,
    body: ClarifyControlTaskRequest,
    handlers: Pick<PlanningStreamHandlers, 'onProgress'> = {},
  ) => postPlanningStream(
    `/control-tasks/${encodeURIComponent(taskId)}/clarify/stream`,
    body,
    handlers,
    { 'Idempotency-Key': body.idempotencyKey },
  ),
  listTasks: () => req<{ tasks: TaskSummary[] }>('/tasks'),
  listControlTasks: () => req<{
    kind: 'current';
    tasks: Array<{
      id: string;
      originalInput: string;
      taskType: string | null;
      state: string;
      createdAt: string;
      updatedAt: string;
    }>;
  }>('/control-tasks'),
  listApprovalTasks: () => req<{ tasks: ControlApprovalTaskSummary[] }>('/control-tasks/approvals'),
  listTaskHistoryPreferences: () => req<{ preferences: TaskHistoryPreference[] }>('/task-history'),
  updateTaskHistoryPreference: (
    kind: TaskHistoryKind,
    taskId: string,
    body: TaskHistoryPreferencePatch,
  ) => req<{ preference: TaskHistoryPreference }>(
    `/task-history/${kind}/${encodeURIComponent(taskId)}`,
    { method: 'PATCH', body },
  ),
  taskDetail: (id: string) =>
    req<TaskDetail>(`/tasks/${id}`),
  feedback: (id: string, b: { rating?: number; adopted?: boolean; comment?: string }) =>
    req<{ id: string }>(`/tasks/${id}/feedback`, { method: 'POST', body: b }),
  skills: () => req<{ skills: SkillItem[] }>('/skills'),
  controlTask: (taskId: string) =>
    req<CurrentTaskReadResponse>(`/control-tasks/${taskId}`),
  selectControlPlan: (taskId: string, body: SelectControlPlanRequest) =>
    req<SelectControlPlanResponse>(`/control-tasks/${taskId}/select`, { method: 'POST', body, headers: { 'Idempotency-Key': body.idempotencyKey } }),
  confirmControlPlan: (taskId: string, body: ConfirmControlPlanRequest) =>
    req<ControlCommandResponse>(`/control-tasks/${taskId}/confirm`, { method: 'POST', body, headers: { 'Idempotency-Key': body.idempotencyKey } }),
  uploadControlDataset: (
    taskId: string,
    planVersionId: string,
    role: string,
    file: File,
    metadata: DatasetUploadMetadata,
    idempotencyKey: string,
  ) => {
    const form = new FormData();
    form.append('file', file);
    form.append('metadata', JSON.stringify(metadata));
    return reqForm<DatasetUploadResponse>(
      `/control-tasks/${encodeURIComponent(taskId)}/plans/${encodeURIComponent(planVersionId)}/inputs/${encodeURIComponent(role)}/dataset`,
      form,
      idempotencyKey,
    );
  },
  uploadControlDocuments: (
    taskId: string,
    planVersionId: string,
    role: string,
    files: readonly File[],
    idempotencyKey: string,
  ) => {
    const form = new FormData();
    for (const file of files) form.append('file', file);
    return reqForm<DocumentUploadResponse>(
      `/control-tasks/${encodeURIComponent(taskId)}/plans/${encodeURIComponent(planVersionId)}/inputs/${encodeURIComponent(role)}/document`,
      form,
      idempotencyKey,
    );
  },
  uploadControlVisuals: (
    taskId: string,
    planVersionId: string,
    role: string,
    files: readonly File[],
    idempotencyKey: string,
  ) => {
    const form = new FormData();
    for (const file of files) form.append('file', file);
    return reqForm<VisualUploadResponse>(
      `/control-tasks/${encodeURIComponent(taskId)}/plans/${encodeURIComponent(planVersionId)}/inputs/${encodeURIComponent(role)}/visual`,
      form,
      idempotencyKey,
    );
  },
  approveControlPlan: (taskId: string, body: ApprovalControlPlanRequest) =>
    req<ControlCommandResponse>(`/control-tasks/${taskId}/approve`, { method: 'POST', body, headers: { 'Idempotency-Key': body.idempotencyKey } }),
  reviseControlPlan: (taskId: string, body: ReviseControlPlanRequest) =>
    req<ReviseControlPlanResponse>(`/control-tasks/${taskId}/revise`, { method: 'POST', body, headers: { 'Idempotency-Key': body.idempotencyKey } }),
  resumeControlPlan: (taskId: string, body: ResumeControlPlanRequest) =>
    req<ControlCommandResponse>(`/control-tasks/${taskId}/resume`, { method: 'POST', body, headers: { 'Idempotency-Key': body.idempotencyKey } }),
  cancelControlPlan: (taskId: string, body: CancelControlPlanRequest) =>
    req<ControlCommandResponse>(`/control-tasks/${taskId}/cancel`, { method: 'POST', body, headers: { 'Idempotency-Key': body.idempotencyKey } }),
  executeControlPlan: (taskId: string, body: ExecutionControlPlanRequest) =>
    req<ControlExecutionResult>(`/control-tasks/${taskId}/execute`, { method: 'POST', body, headers: { 'Idempotency-Key': body.idempotencyKey } }),
  controlVisualAsset: async (taskId: string, assetId: string): Promise<ControlVisualAssetResponse> => {
    const response = await reqBlob(
      `/control-tasks/${encodeURIComponent(taskId)}/assets/${encodeURIComponent(assetId)}`,
    );
    const mediaType = response.headers.get('content-type')?.split(';', 1)[0];
    if (
      mediaType !== 'image/png'
      && mediaType !== 'image/jpeg'
      && mediaType !== 'image/webp'
      && mediaType !== 'image/svg+xml'
    ) {
      throw new ApiError(502, '视觉资产媒体类型无效');
    }
    return { blob: await response.blob(), mediaType };
  },
  controlHtmlBundle: async (
    taskId: string,
    attemptId: string,
  ): Promise<ControlHtmlBundleResponse> => {
    const response = await reqBlob(
      `/control-tasks/${encodeURIComponent(taskId)}/reports/${encodeURIComponent(attemptId)}/html-bundle`,
    );
    const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (mediaType !== 'application/zip') {
      throw new ApiError(502, '离线 HTML 报告包媒体类型无效');
    }
    return { blob: await response.blob() };
  },
  controlEditorialSummary: async (
    taskId: string,
    attemptId: string,
  ): Promise<ControlHtmlBundleResponse> => {
    const response = await reqBlob(
      `/control-tasks/${encodeURIComponent(taskId)}/reports/${encodeURIComponent(attemptId)}/editorial-summary.html`,
    );
    const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (mediaType !== 'text/html') {
      throw new ApiError(502, '编辑摘要媒体类型无效');
    }
    return { blob: await response.blob() };
  },
  controlFinalReport: (taskId: string) =>
    req<ControlFinalReport>(`/control-tasks/${encodeURIComponent(taskId)}/final-report`),
  controlSkillResults: (taskId: string) =>
    req<{ results: NativeSkillResult[] }>(`/control-tasks/${encodeURIComponent(taskId)}/skill-results`),
  controlFinalReportHtml: async (taskId: string): Promise<ControlHtmlBundleResponse> => {
    const response = await reqBlob(
      `/control-tasks/${encodeURIComponent(taskId)}/final-report.html`,
    );
    const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (mediaType !== 'text/html') throw new ApiError(502, '最终 HTML 报告媒体类型无效');
    return { blob: await response.blob() };
  },
  controlFinalReportZip: async (taskId: string): Promise<ControlHtmlBundleResponse> => {
    const response = await reqBlob(
      `/control-tasks/${encodeURIComponent(taskId)}/final-report.zip`,
    );
    const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (mediaType !== 'application/zip') throw new ApiError(502, '离线报告媒体类型无效');
    return { blob: await response.blob() };
  },
  controlDeliverable: async (taskId: string) => parseControlDeliverableResponse(
    await req<unknown>(`/control-tasks/${taskId}/deliverable`),
  ),
  zeroStatus: () => req<ZeroIntegrationStatusResponse>('/integrations/zero/status'),
  createZeroPublication: (
    taskId: string,
    body: CreateZeroPublicationRequest,
    idempotencyKey: string,
  ) => req<ZeroPublicationResponse>(`/control-tasks/${encodeURIComponent(taskId)}/publications/zero`, {
    method: 'POST',
    body,
    headers: { 'Idempotency-Key': idempotencyKey },
  }),
  zeroPublication: (taskId: string, publicationId: string) => req<ZeroPublicationResponse>(
    `/control-tasks/${encodeURIComponent(taskId)}/publications/zero/${encodeURIComponent(publicationId)}`,
  ),
};
