import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TaskFollowUpError,
  TaskFollowUpService,
  buildTaskFollowUpContext,
  type TaskFollowUpStore,
  type TaskFollowUpTask,
} from '../apps/orchestrator-runtime/src/report/task-follow-up-service.ts';
import type {
  LLMClient,
  StructuredLLMCallOptions,
} from '../apps/orchestrator-runtime/src/runtime/llm-client.ts';
import {
  NATIVE_FINAL_REPORT_VERSION,
  type NativeFinalReport,
} from '../packages/api-contract/native-skill-orchestration.ts';
import type { TaskFollowUpResponse } from '../packages/api-contract/control-workflow.ts';

const task: TaskFollowUpTask = {
  id: 'task-follow-up',
  conversationId: 'conversation-follow-up',
  ownerUserId: 'owner-follow-up',
  conversationOwnerUserId: 'owner-follow-up',
  state: 'completed',
  stateVersion: 7,
};

const report: NativeFinalReport = {
  version: NATIVE_FINAL_REPORT_VERSION,
  taskId: task.id,
  planVersionId: 'plan-follow-up',
  attemptId: 'attempt-follow-up',
  mode: 'single_skill',
  title: '体验诊断报告',
  primary: {
    format: 'markdown',
    content: '# 体验诊断\n\n首要问题是结算入口不清晰。',
    contentHash: `sha256:${'1'.repeat(64)}`,
  },
  attachments: [],
  sources: [{ id: 'S-1', title: '用户上传截图', type: 'user_input' }],
  gaps: [],
  skillResults: [],
};

function fakeLlm(output: unknown, calls: { count: number }): LLMClient {
  return {
    identity: {
      provider: 'fixture', endpointHost: 'fixture.test', requestedModel: 'fixture-model',
      mode: 'mock', eligibleAsReal: false,
    },
    async generateStructured<T>(_options: StructuredLLMCallOptions) {
      calls.count += 1;
      return {
        data: structuredClone(output) as T,
        promptHash: `sha256:${'2'.repeat(64)}`,
        modelName: 'fixture-model',
        modelVersion: '1',
        traceId: 'trace-follow-up',
      };
    },
    async generateText() {
      throw new Error('text generation must not be used');
    },
  };
}

function fakeStore(): TaskFollowUpStore & {
  completed: TaskFollowUpResponse | null;
  releaseCount: number;
} {
  return {
    completed: null,
    releaseCount: 0,
    async listTaskFollowUps() {
      return this.completed?.messages ?? [];
    },
    async reserveFollowUpCommand() {
      return this.completed
        ? { status: 'replay', response: this.completed }
        : { status: 'reserved', reservationToken: 'reservation-1' };
    },
    async waitForCommand() {
      return this.completed
        ? { status: 'replay', response: this.completed }
        : { status: 'timeout' };
    },
    async completeFollowUpCommand(input) {
      this.completed = input.response;
    },
    async releaseCommand() {
      this.releaseCount += 1;
      return true;
    },
  };
}

test('report follow-up uses the sealed report, persists one turn, and replays idempotently', async () => {
  const calls = { count: 0 };
  const store = fakeStore();
  const service = new TaskFollowUpService({
    llm: fakeLlm({ answerMarkdown: '因为结算入口缺少视觉层级。', sourceIds: ['S-1'], gaps: [] }, calls),
    store,
    expectedActualModel: 'fixture-model',
  });

  const input = {
    task,
    report: { artifact: { id: 'report-artifact', contentSha256: `sha256:${'3'.repeat(64)}` }, report },
    ownerUserId: task.ownerUserId,
    message: '为什么这是首要问题？',
    idempotencyKey: 'follow-up-key',
  };
  const first = await service.create(input);
  const replay = await service.create(input);

  assert.equal(calls.count, 1);
  assert.deepEqual(replay, first);
  assert.deepEqual(first.messages.map(({ role }) => role), ['user', 'assistant']);
  assert.equal(first.messages[1]?.content, '因为结算入口缺少视觉层级。');
  assert.deepEqual(first.messages[1]?.sourceIds, ['S-1']);
  assert.match(buildTaskFollowUpContext({ report, previousMessages: first.messages }).reportContent, /首要问题/u);
});

test('report follow-up rejects unknown sources and releases its command reservation', async () => {
  const store = fakeStore();
  const service = new TaskFollowUpService({
    llm: fakeLlm({ answerMarkdown: '无法验证。', sourceIds: ['S-unknown'], gaps: [] }, { count: 0 }),
    store,
    expectedActualModel: 'fixture-model',
  });

  await assert.rejects(() => service.create({
    task,
    report: { artifact: { id: 'report-artifact', contentSha256: `sha256:${'3'.repeat(64)}` }, report },
    ownerUserId: task.ownerUserId,
    message: '来源是什么？',
    idempotencyKey: 'invalid-source-key',
  }), (error: unknown) => (
    error instanceof TaskFollowUpError && error.code === 'invalid_model_output'
  ));
  assert.equal(store.completed, null);
  assert.equal(store.releaseCount, 1);
});
