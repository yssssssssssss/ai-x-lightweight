import { createHash, randomUUID } from 'node:crypto';

import type {
  ControlCommandReservation,
  ControlCommandWaitResult,
  ControlTaskState,
} from '../../../../database/control-plane.ts';
import {
  TASK_FOLLOW_UP_MESSAGE_VERSION,
  type TaskFollowUpMessageV1,
  type TaskFollowUpResponse,
} from '../../../../packages/api-contract/control-workflow.ts';
import {
  HISTORICAL_FINAL_REPORT_VERSION,
  type ControlFinalReport,
} from '../../../../packages/api-contract/historical-final-report.ts';
import type {
  NativeReportBlock,
  NativeReportDocumentV1,
  SourceReference,
} from '../../../../packages/api-contract/native-skill-orchestration.ts';
import type { LLMClient } from '../runtime/llm-client.ts';

const FOLLOW_UP_SCHEMA_NAME = 'task-follow-up-v1';
const FOLLOW_UP_COMMAND_TYPE = 'report_follow_up';
const MAX_QUESTION_LENGTH = 4_000;
const MAX_CONTEXT_BYTES = 512 * 1024;
const MAX_HISTORY_MESSAGES = 10;

interface FollowUpDraft {
  answerMarkdown: string;
  sourceIds: string[];
  gaps: string[];
}

export interface TaskFollowUpTask {
  id: string;
  conversationId: string;
  ownerUserId: string;
  conversationOwnerUserId: string;
  state: ControlTaskState;
  stateVersion: number;
}

export interface TaskFollowUpReport {
  artifact: {
    id: string;
    contentSha256: string | null;
  };
  report: ControlFinalReport;
}

export interface TaskFollowUpStore {
  listTaskFollowUps(input: {
    taskId: string;
    ownerUserId: string;
  }): Promise<TaskFollowUpMessageV1[]>;
  reserveFollowUpCommand(input: {
    taskId: string;
    idempotencyKey: string;
    requestHash: string;
    expectedVersion: number;
    actorUserId: string;
  }): Promise<ControlCommandReservation>;
  waitForCommand(input: {
    taskId: string;
    commandType: string;
    idempotencyKey: string;
    requestHash: string;
    timeoutMs?: number;
  }): Promise<ControlCommandWaitResult>;
  completeFollowUpCommand(input: {
    taskId: string;
    conversationId: string;
    idempotencyKey: string;
    requestHash: string;
    expectedVersion: number;
    reservationToken: string;
    state: 'completed' | 'completed_with_gaps';
    finalReportArtifactId: string;
    response: TaskFollowUpResponse;
  }): Promise<void>;
  releaseCommand(input: {
    taskId: string;
    commandType: string;
    idempotencyKey: string;
    requestHash: string;
    expectedVersion: number;
    reservationToken: string;
  }): Promise<boolean>;
}

export class TaskFollowUpError extends Error {
  constructor(
    readonly code: 'invalid_request' | 'report_unavailable' | 'request_conflict' | 'invalid_model_output',
    message: string,
  ) {
    super(message);
    this.name = 'TaskFollowUpError';
  }
}

function blockText(block: NativeReportBlock): string {
  if (block.type === 'markdown') return block.content;
  if (block.type === 'table') {
    return [block.columns.join(' | '), ...block.rows.map((row) => row.join(' | '))].join('\n');
  }
  if (block.type === 'metric-group') {
    return block.metrics.map(({ label, value, note }) => (
      `${label}: ${value}${note ? `（${note}）` : ''}`
    )).join('\n');
  }
  if (block.type === 'image') return `图片：${block.caption}\n说明：${block.altText}`;
  if (block.type === 'quadrant') {
    return [
      `象限：横轴 ${block.xAxis}；纵轴 ${block.yAxis}`,
      ...block.points.map(({ label, x, y }) => `${label}: (${x}, ${y})`),
    ].join('\n');
  }
  if (block.type === 'timeline') {
    return block.items.map(({ title, description, tag }) => (
      `${tag ? `[${tag}] ` : ''}${title}: ${description}`
    )).join('\n');
  }
  return [
    `线框：${block.title}`,
    ...block.elements.map(({ label, description }) => `${label}${description ? `: ${description}` : ''}`),
  ].join('\n');
}

function reportDocumentText(document: NativeReportDocumentV1): string {
  const output = [document.title];
  if (document.subtitle) output.push(document.subtitle);
  if (document.summary) {
    output.push(
      `结论：${document.summary.conclusion}`,
      ...document.summary.findings.map((value) => `发现：${value}`),
      ...document.summary.actions.map((value) => `行动：${value}`),
    );
  }
  for (const tab of document.tabs) {
    output.push(`# ${tab.title}`);
    for (const section of tab.sections) {
      output.push(`## ${section.title}`, ...section.blocks.map(blockText));
    }
  }
  return output.join('\n\n');
}

function boundedUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return `${bytes.subarray(0, end).toString('utf8')}\n\n[报告上下文已按固定预算截断]`;
}

export function buildTaskFollowUpContext(input: {
  report: ControlFinalReport;
  previousMessages: readonly TaskFollowUpMessageV1[];
}): {
  reportTitle: string;
  reportContent: string;
  sources: SourceReference[];
  gaps: string[];
  recentMessages: Array<{ role: 'user' | 'assistant'; content: string }>;
} {
  const content = input.report.version === HISTORICAL_FINAL_REPORT_VERSION
    ? input.report.markdown
    : input.report.reportDocument
      ? reportDocumentText(input.report.reportDocument)
      : input.report.primary.content;
  return {
    reportTitle: input.report.title,
    reportContent: boundedUtf8(content, MAX_CONTEXT_BYTES),
    sources: input.report.sources,
    gaps: input.report.gaps,
    recentMessages: input.previousMessages.slice(-MAX_HISTORY_MESSAGES).map(({ role, content: text }) => ({
      role,
      content: text,
    })),
  };
}

function parseDraft(value: unknown, allowedSourceIds: ReadonlySet<string>): FollowUpDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TaskFollowUpError('invalid_model_output', '追问回答格式无效');
  }
  const draft = value as Partial<FollowUpDraft>;
  if (
    typeof draft.answerMarkdown !== 'string'
    || draft.answerMarkdown.trim() === ''
    || !Array.isArray(draft.sourceIds)
    || draft.sourceIds.some((sourceId) => typeof sourceId !== 'string' || !allowedSourceIds.has(sourceId))
    || new Set(draft.sourceIds).size !== draft.sourceIds.length
    || !Array.isArray(draft.gaps)
    || draft.gaps.some((gap) => typeof gap !== 'string' || gap.trim() === '')
  ) {
    throw new TaskFollowUpError('invalid_model_output', '追问回答格式无效或引用了未知来源');
  }
  return {
    answerMarkdown: draft.answerMarkdown.trim(),
    sourceIds: draft.sourceIds,
    gaps: draft.gaps,
  };
}

function parseReplay(value: unknown): TaskFollowUpResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TaskFollowUpError('request_conflict', '追问请求回放结果无效');
  }
  const messages = (value as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length !== 2) {
    throw new TaskFollowUpError('request_conflict', '追问请求回放结果无效');
  }
  const parsed = messages.map((candidate, index): TaskFollowUpMessageV1 => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new TaskFollowUpError('request_conflict', '追问请求回放结果无效');
    }
    const message = candidate as Partial<TaskFollowUpMessageV1>;
    const expectedRole = index === 0 ? 'user' : 'assistant';
    if (
      message.version !== TASK_FOLLOW_UP_MESSAGE_VERSION
      || typeof message.id !== 'string'
      || typeof message.taskId !== 'string'
      || message.role !== expectedRole
      || typeof message.content !== 'string'
      || !Array.isArray(message.sourceIds)
      || message.sourceIds.some((sourceId) => typeof sourceId !== 'string')
      || !Array.isArray(message.gaps)
      || message.gaps.some((gap) => typeof gap !== 'string')
      || typeof message.createdAt !== 'string'
    ) {
      throw new TaskFollowUpError('request_conflict', '追问请求回放结果无效');
    }
    return message as TaskFollowUpMessageV1;
  });
  return { messages: parsed };
}

function followUpRequestHash(input: {
  taskId: string;
  ownerUserId: string;
  reportArtifactId: string;
  reportContentSha256: string;
  message: string;
}): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(input)).digest('hex')}`;
}

export class TaskFollowUpService {
  constructor(private readonly dependencies: {
    llm: LLMClient;
    store: TaskFollowUpStore;
    expectedActualModel: string;
  }) {}

  list(input: { taskId: string; ownerUserId: string }): Promise<TaskFollowUpMessageV1[]> {
    return this.dependencies.store.listTaskFollowUps(input);
  }

  async create(input: {
    task: TaskFollowUpTask;
    report: TaskFollowUpReport;
    ownerUserId: string;
    message: string;
    idempotencyKey: string;
  }): Promise<TaskFollowUpResponse> {
    const message = input.message.trim();
    if (!message || message.length > MAX_QUESTION_LENGTH) {
      throw new TaskFollowUpError('invalid_request', '追问内容必须为 1 至 4000 个字符');
    }
    if (
      input.task.ownerUserId !== input.ownerUserId
      || input.task.conversationOwnerUserId !== input.ownerUserId
    ) {
      throw new TaskFollowUpError('report_unavailable', '报告不存在');
    }
    if (input.task.state !== 'completed' && input.task.state !== 'completed_with_gaps') {
      throw new TaskFollowUpError('report_unavailable', '任务尚未生成最终报告');
    }
    if (
      input.report.report.taskId !== input.task.id
      || input.report.artifact.contentSha256 === null
    ) {
      throw new TaskFollowUpError('report_unavailable', '最终报告绑定无效');
    }

    const requestHash = followUpRequestHash({
      taskId: input.task.id,
      ownerUserId: input.ownerUserId,
      reportArtifactId: input.report.artifact.id,
      reportContentSha256: input.report.artifact.contentSha256,
      message,
    });
    let reservationToken: string | null = null;
    while (!reservationToken) {
      const reservation = await this.dependencies.store.reserveFollowUpCommand({
        taskId: input.task.id,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        expectedVersion: input.task.stateVersion,
        actorUserId: input.ownerUserId,
      });
      if (reservation.status === 'conflict') {
        throw new TaskFollowUpError('request_conflict', '该追问请求标识已用于其他内容');
      }
      if (reservation.status === 'replay') return parseReplay(reservation.response);
      if (reservation.status === 'pending') {
        const waited = await this.dependencies.store.waitForCommand({
          taskId: input.task.id,
          commandType: FOLLOW_UP_COMMAND_TYPE,
          idempotencyKey: input.idempotencyKey,
          requestHash,
        });
        if (waited.status === 'replay') return parseReplay(waited.response);
        if (waited.status === 'released') continue;
        if (waited.status === 'conflict') {
          throw new TaskFollowUpError('request_conflict', '该追问请求标识已用于其他内容');
        }
        throw new TaskFollowUpError('request_conflict', '相同追问正在处理中，请稍后重试');
      }
      reservationToken = reservation.reservationToken;
    }

    try {
      const previousMessages = await this.dependencies.store.listTaskFollowUps({
        taskId: input.task.id,
        ownerUserId: input.ownerUserId,
      });
      const context = buildTaskFollowUpContext({ report: input.report.report, previousMessages });
      const allowedSourceIds = new Set(context.sources.map(({ id }) => id));
      const generated = await this.dependencies.llm.generateStructured<FollowUpDraft>({
        schemaName: FOLLOW_UP_SCHEMA_NAME,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['answerMarkdown', 'sourceIds', 'gaps'],
          properties: {
            answerMarkdown: { type: 'string', minLength: 1 },
            sourceIds: { type: 'array', items: { type: 'string' }, uniqueItems: true },
            gaps: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true },
          },
        },
        prompt: [
          '请只基于 context 中已封存的报告回答用户追问。',
          '不得调用工具、补充新事实、修改原报告或伪造来源。',
          '使用简体中文；证据不足时写入 gaps。',
          'sourceIds 只能引用 context.sources 中存在的 ID。',
          `用户追问：${message}`,
        ].join('\n'),
        context,
        receipt: {
          stage: 'report_follow_up',
          attemptId: input.report.report.attemptId,
          expectedModel: this.dependencies.expectedActualModel,
        },
      });
      const draft = parseDraft(generated.data, allowedSourceIds);
      const createdAt = Date.now();
      const response: TaskFollowUpResponse = {
        messages: [{
          version: TASK_FOLLOW_UP_MESSAGE_VERSION,
          id: randomUUID(),
          taskId: input.task.id,
          role: 'user',
          content: message,
          sourceIds: [],
          gaps: [],
          createdAt: new Date(createdAt).toISOString(),
        }, {
          version: TASK_FOLLOW_UP_MESSAGE_VERSION,
          id: randomUUID(),
          taskId: input.task.id,
          role: 'assistant',
          content: draft.answerMarkdown,
          sourceIds: draft.sourceIds,
          gaps: draft.gaps,
          createdAt: new Date(createdAt + 1).toISOString(),
        }],
      };
      await this.dependencies.store.completeFollowUpCommand({
        taskId: input.task.id,
        conversationId: input.task.conversationId,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        expectedVersion: input.task.stateVersion,
        reservationToken,
        state: input.task.state,
        finalReportArtifactId: input.report.artifact.id,
        response,
      });
      return response;
    } catch (error) {
      const released = await this.dependencies.store.releaseCommand({
        taskId: input.task.id,
        commandType: FOLLOW_UP_COMMAND_TYPE,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        expectedVersion: input.task.stateVersion,
        reservationToken,
      });
      if (!released) {
        const waited = await this.dependencies.store.waitForCommand({
          taskId: input.task.id,
          commandType: FOLLOW_UP_COMMAND_TYPE,
          idempotencyKey: input.idempotencyKey,
          requestHash,
        });
        if (waited.status === 'replay') return parseReplay(waited.response);
      }
      throw error;
    }
  }
}
