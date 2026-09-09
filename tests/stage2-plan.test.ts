import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  buildPlanConfirmationPayload,
  parseDatasetColumns,
  reconcileDatasetColumnMetadata,
} from '../apps/web/src/components/stages/stage2-plan-confirmation.ts';

const component = new URL('../apps/web/src/components/stages/Stage2Plan.tsx', import.meta.url);
const taskFlow = new URL('../apps/web/src/hooks/useTaskFlow.ts', import.meta.url);

test('Stage2Plan renders frozen competitive weights as read-only definition data', async () => {
  const source = await readFile(component, 'utf8');
  const start = source.indexOf('{scoringWeights.length > 0');
  const end = source.indexOf('\n      <div style={{ marginTop: 16 }}>', start);
  assert.ok(start >= 0 && end > start);
  const weightBlock = source.slice(start, end);

  assert.match(source, /extractCompetitiveScoringWeights\(plan\.plan\)/u);
  assert.match(weightBlock, /<dl/u);
  assert.match(weightBlock, /<dt/u);
  assert.match(weightBlock, /<dd/u);
  assert.doesNotMatch(weightBlock, /<input|<textarea|onChange|setScoring/u);
});

test('Stage2Plan renders frozen resource cardinality gaps before confirmation', async () => {
  const source = await readFile(component, 'utf8');
  assert.match(source, /skill_invocations\?\.flatMap/u);
  assert.match(source, /知识资源缺口/u);
  assert.match(source, /部分可选知识材料暂不可用/u);
  assert.doesNotMatch(source, /gap\.query_id/u);
});

test('Stage2Plan exposes CSV field descriptions and units after reading the selected header', async () => {
  const source = await readFile(component, 'utf8');
  assert.match(source, /parseDatasetColumns\(await file\.text\(\)\)/u);
  assert.match(source, /字段说明与单位（选填）/u);
  assert.match(source, /editDatasetColumnMetadata\(datasetInput\.role, 'fieldNotes'/u);
  assert.match(source, /editDatasetColumnMetadata\(datasetInput\.role, 'units'/u);
  assert.match(source, /Boolean\(datasetHeaderErrors\[input\.role\]\)/u);
});

test('Stage2Plan clearly requires local JPG, PNG, or WebP upload for visual inputs', async () => {
  const source = await readFile(component, 'utf8');
  assert.match(source, /请从本机选择 JPG、PNG 或 WebP 图片/u);
  assert.match(source, /不支持用图片 URL 或本机文件路径代替上传/u);
  assert.match(source, /单张最大 10 MiB/u);
  assert.match(source, /可选择多张，最多 12 张/u);
  assert.match(source, /请选择 1 张/u);
  assert.match(source, /IMAGE_FILE_ACCEPT/u);
  assert.match(source, /\.jpg,\.jpeg,\.png,\.webp,image\/jpeg,image\/png,image\/webp/u);
  assert.doesNotMatch(source, /accept="image\/\*"/u);
});

test('Stage2 confirmation payload includes only declared pending inputs and no weight copy', () => {
  const screenshot = new File(['fixture'], 'screen.png', { type: 'image/png' });
  const payload = buildPlanConfirmationPayload({
    confirmationAnswers: { scope: '中国主流平台' },
    pending: [{
      kind: 'value',
      role: 'competitors',
      label: '竞品',
      multiple: true,
      targets: [{ step_no: 2, tool_id: 'competitive-web-research', field: 'competitors', multiple: true }],
    }, {
      kind: 'visual',
      role: 'screenshots',
      label: '截图',
      multiple: false,
      targets: [{ step_no: 2, tool_id: 'competitive-web-research', field: 'screenshots', multiple: false }],
    }],
    values: {
      competitors: '京东\n淘宝',
      scoring_weights: '{"需求理解": 1}',
    },
    images: {
      screenshots: [screenshot],
      scoring_weights: [new File(['fixture'], 'ignored.txt', { type: 'text/plain' })],
    },
  });

  assert.deepEqual(payload, {
    confirmationAnswers: { scope: '中国主流平台' },
    inputValues: { competitors: ['京东', '淘宝'] },
    visualUploads: [{ role: 'screenshots', files: [screenshot] }],
    datasetUploads: [],
  });
  assert.equal(JSON.stringify(payload).includes('scoring_weights'), false);
});

test('Stage2 confirmation omits explicitly waived optional inputs', () => {
  const payload = buildPlanConfirmationPayload({
    confirmationAnswers: {},
    pending: [{
      kind: 'value',
      role: 'user_materials',
      label: '用户材料',
      multiple: true,
      targets: [{ step_no: 2, tool_id: 'generate-persona', field: 'user_materials', multiple: true }],
    }],
    values: { user_materials: '' },
    images: {},
    waivedInputKeys: ['user_materials'],
  });
  assert.deepEqual(payload, {
    confirmationAnswers: {},
    inputValues: {},
    visualUploads: [],
    datasetUploads: [],
    waivedInputKeys: ['user_materials'],
  });
});

test('Stage2Plan offers document uploads without an anonymization confirmation', async () => {
  const source = await readFile(component, 'utf8');
  assert.match(source, /支持 Markdown 和 TXT/u);
  assert.match(source, /accept="\.md,\.txt,text\/markdown,text\/plain"/u);
  assert.doesNotMatch(source, /readAsDataURL/u);
  assert.doesNotMatch(source, /我确认文件已匿名化/u);
});

test('Stage2 confirmation keeps uploaded documents as opaque pre-upload requests', () => {
  const files = [
    new File(['# 背景'], 'background.md', { type: 'text/markdown' }),
    new File(['访谈内容'], 'interview.txt', { type: 'text/plain' }),
  ];
  const payload = buildPlanConfirmationPayload({
    confirmationAnswers: {},
    pending: [{
      kind: 'document', role: 'internal_documents', label: '内部业务材料', multiple: true,
      targets: [{ step_no: 4, tool_id: 'industry-market-analysis', field: 'internal_documents', multiple: true }],
    }],
    values: {}, images: {}, documents: { internal_documents: files },
  });

  assert.deepEqual(payload.inputValues, {});
  assert.deepEqual(payload.visualUploads, []);
  assert.deepEqual(payload.datasetUploads, []);
  assert.deepEqual(payload.documentUploads, [{ role: 'internal_documents', files }]);
});

test('Stage2 keeps selected materials available when upload or confirmation fails', async () => {
  const [componentSource, taskFlowSource] = await Promise.all([
    readFile(component, 'utf8'),
    readFile(taskFlow, 'utf8'),
  ]);
  const awaitConfirm = componentSource.indexOf('await onConfirm(');
  const markConfirmed = componentSource.indexOf('setConfirmed(true)', awaitConfirm);
  assert.ok(awaitConfirm >= 0 && markConfirmed > awaitConfirm);
  assert.match(componentSource, /setSubmitError\(error instanceof Error/u);
  assert.match(componentSource, /正在上传并确认/u);
  assert.match(taskFlowSource, /await runIntakeUploads\(operations\)/u);
  assert.match(taskFlowSource, /intakeUploadCache\.current\.get/u);
  assert.match(taskFlowSource, /setPhase\('planned'\);\s*throw cause/u);
});

test('Stage2 parses quoted UTF-8 CSV headers and scopes field metadata to the selected columns', () => {
  const columns = parseDatasetColumns('\uFEFFsample_id,"quote,raw",score\r\nu1,"价格,太复杂",3\r\n');
  assert.deepEqual(columns, ['sample_id', 'quote,raw', 'score']);
  assert.deepEqual(reconcileDatasetColumnMetadata({
    rowMeaning: '一行代表一位匿名受访者',
    timeRange: '2026-Q3',
    fieldNotes: { score: '满意度评分', obsolete: '旧字段' },
    units: { score: '分', obsolete: '次' },
    sampling: '访谈样本',
    piiConfirmedAbsent: true,
  }, columns), {
    rowMeaning: '一行代表一位匿名受访者',
    timeRange: '2026-Q3',
    fieldNotes: { sample_id: '', 'quote,raw': '', score: '满意度评分' },
    units: { sample_id: '', 'quote,raw': '', score: '分' },
    sampling: '访谈样本',
    piiConfirmedAbsent: true,
  });
});

test('Stage2 confirmation keeps an uploaded Dataset as an opaque pre-upload request', () => {
  const file = new File(['sample_id,quote\nu1,hello\n'], 'users.csv', { type: 'text/csv' });
  const dataset = {
    role: 'user_research_dataset',
    file,
    metadata: {
      rowMeaning: '一行代表一位匿名受访者',
      timeRange: '2026-Q3',
      fieldNotes: { sample_id: '匿名样本编号', quote: '用户原话' },
      units: { score: '分' },
      sampling: '访谈样本',
      piiConfirmedAbsent: true,
    },
  };
  const payload = buildPlanConfirmationPayload({
    confirmationAnswers: {},
    pending: [{
      kind: 'dataset', role: dataset.role, label: '用户研究 CSV', multiple: false,
      targets: [{ step_no: 4, tool_id: 'industry-market-analysis', field: dataset.role, multiple: false }],
    }],
    values: {}, images: {}, datasets: { [dataset.role]: dataset },
  });

  assert.deepEqual(payload.inputValues, {});
  assert.deepEqual(payload.visualUploads, []);
  assert.deepEqual(payload.datasetUploads, [dataset]);
});
