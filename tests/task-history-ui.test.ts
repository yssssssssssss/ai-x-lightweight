import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const theme = new URL('../apps/web/src/theme.css', import.meta.url);
const workbench = new URL('../apps/web/src/pages/Workbench.tsx', import.meta.url);
const sidebar = new URL('../apps/web/src/components/Sidebar.tsx', import.meta.url);
const composer = new URL('../apps/web/src/components/Composer.tsx', import.meta.url);
const taskFlow = new URL('../apps/web/src/hooks/useTaskFlow.ts', import.meta.url);

test('workbench has one contained scroll chain and a non-scrolling bottom composer', async () => {
  const [css, workbenchSource, composerSource] = await Promise.all([
    readFile(theme, 'utf8'),
    readFile(workbench, 'utf8'),
    readFile(composer, 'utf8'),
  ]);

  assert.match(css, /\.workbench\s*\{[^}]*position:\s*fixed[^}]*overflow:\s*hidden/su);
  assert.match(css, /\.workbench-main\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*hidden/su);
  assert.match(css, /\.workbench-scroll\s*\{[^}]*overflow-y:\s*auto[^}]*overscroll-behavior-y:\s*contain/su);
  assert.match(css, /\.composer\s*\{[^}]*flex:\s*0 0 auto/su);
  assert.doesNotMatch(workbenchSource, /overflowY:\s*'auto'/u);
  assert.match(workbenchSource, /className="workbench-scroll"/u);
  assert.match(composerSource, /className="composer"/u);
});

test('deliverable validation retry explains terminal rebuild before full retry fallback', async () => {
  const source = await readFile(workbench, 'utf8');
  assert.match(source, /failure\?\.kind === 'deliverable_validation'/u);
  assert.match(source, /优先复用已验证的计划步骤，只重新构建 Canonical Deliverable/u);
  assert.match(source, /复用校验失败时才回退为完整重试/u);
});

test('current conversation renders each user turn before assistant stages and isolates loading state', async () => {
  const [source, css] = await Promise.all([
    readFile(workbench, 'utf8'),
    readFile(theme, 'utf8'),
  ]);
  const timelineStart = source.indexOf('<div className={`chat-column');
  const timelineEnd = source.indexOf('<Composer', timelineStart);
  assert.ok(timelineStart >= 0 && timelineEnd > timelineStart, 'current conversation timeline must exist');
  const timeline = source.slice(timelineStart, timelineEnd);

  assert.match(
    timeline,
    /phase === 'idle'\s*\?\s*\([\s\S]*?: phase === 'loading-task'\s*\?\s*\([\s\S]*?:\s*\(\s*<>\s*\{originalInput\s*\?\s*\(\s*<UserBubble/u,
    'idle, loading, and active conversation states must be mutually exclusive',
  );

  const userTurn = timeline.indexOf('{originalInput ? (');
  assert.ok(userTurn >= 0, 'active conversation must render the submitted user input');
  assert.ok(timeline.indexOf('<TaskTimeSummary', userTurn) > userTurn);
  for (const assistantTurn of [
    "{clarification && phase === 'clarifying'",
    '{candidatesResp && (',
    "{phase === 'planning' && <PlanProgressCard",
    "{phase === 'awaiting-approval' && (",
    "{phase === 'ready' && <ReadyExecutionNotice",
  ]) {
    const assistantTurnIndex = timeline.indexOf(assistantTurn);
    assert.ok(assistantTurnIndex > userTurn, `${assistantTurn} must follow the user turn`);
  }
  assert.match(
    timeline,
    /clarificationSubmitting\s*\?\s*\(\s*<PlanProgressCard steps=\{progress\} variant="clarification"/u,
    'clarification submission must expose the live planning steps',
  );

  assert.match(css, /\.task-time-summary/u);
  assert.match(css, /\.user-bubble time/u);

  const chatColumnRule = css.match(/\.chat-column\s*\{[^}]*\}/u)?.[0] ?? '';
  assert.doesNotMatch(chatColumnRule, /column-reverse|direction:\s*rtl/u);
});

test('active tasks poll lightweight status and fetch the full task only after change', async () => {
  const source = await readFile(taskFlow, 'utf8');
  assert.match(source, /api\.controlTaskStatus\(currentTaskId\)/u);
  assert.match(source, /signature !== statusSignatureRef\.current/u);
  assert.match(source, /Math\.min\(delay \* 2, MAX_POLL_DELAY_MS\)/u);
  assert.match(source, /document\.hidden \? MAX_POLL_DELAY_MS : delay/u);
});

test('Knowledge configuration drift exposes replan and abort instead of retry', async () => {
  const source = await readFile(workbench, 'utf8');
  assert.match(source, /executionFailureAllowsAction\(failure, 'replan'\)/u);
  assert.match(source, /onReplan=\{\(\) => flow\.revisePlan/u);
  assert.match(source, /重新生成计划/u);
});

test('sidebar exposes four status tabs and persistent item management actions', async () => {
  const source = await readFile(sidebar, 'utf8');

  for (const label of ['待处理', '进行中', '已完成', '失败']) assert.match(source, new RegExp(label));
  assert.match(source, /history-task-time/u);
  assert.match(source, /完成于/u);
  assert.match(source, /用时/u);
  assert.match(source, /role="tablist"/u);
  assert.match(source, /aria-haspopup="menu"/u);
  assert.match(source, /置顶/u);
  assert.match(source, /重命名/u);
  assert.match(source, /确认删除/u);
  assert.match(source, /hidden:\s*true/u);
  assert.match(source, /ArrowLeft/u);
  assert.match(source, /ArrowRight/u);
});
