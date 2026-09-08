import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createNativeSkillResult,
  finalizeMultiNativeReport,
  finalizeSingleNativeReport,
  renderNativeFinalReportHtml,
  sanitizeNativeHtml,
  NATIVE_SKILL_RESULT_DRAFT_SCHEMA,
  type NativeReportWriter,
} from '../apps/orchestrator-runtime/src/report/native-reporting.ts';
import {
  NATIVE_FINAL_REPORT_VERSION,
  NATIVE_SKILL_EXECUTION_PLAN_VERSION,
  NATIVE_SKILL_RESULT_VERSION,
  parseNativeFinalReport,
  parseNativeSkillExecutionPlanV1,
  parseNativeSkillResult,
  type NativeSkillRunSpec,
} from '../packages/api-contract/native-skill-orchestration.ts';
import {
  HISTORICAL_FINAL_REPORT_VERSION,
  parseHistoricalFinalReportV1,
} from '../packages/api-contract/historical-final-report.ts';
import { MockLLMClient } from '../apps/orchestrator-runtime/src/runtime/llm-client.ts';
import { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function runSpec(): NativeSkillRunSpec {
  const body = '---\nname: native-test\ndescription: Native test.\n---\n# Native test\nRead references/method.md.';
  const reference = '# Method\n';
  const files = [
    { path: 'SKILL.md', mediaType: 'text/markdown', byteSize: Buffer.byteLength(body), contentHash: digest(body) },
    { path: 'references/method.md', mediaType: 'text/markdown', byteSize: Buffer.byteLength(reference), contentHash: digest(reference) },
  ];
  const manifest = files.map(({ path, mediaType, byteSize, contentHash }) => (
    `${path}\0${mediaType}\0${byteSize}\0${contentHash}\n`
  )).join('');
  return {
    skill_id: 'native-test',
    body,
    body_hash: digest(body),
    package_hash: digest(manifest),
    entry_path: 'SKILL.md',
    files,
    selected_references: [{
      source: 'skill_package',
      sourceId: 'native-test',
      logicalPath: 'skill://native-test/references/method.md',
      path: 'references/method.md',
      contentHash: digest(reference),
      content: reference,
      selectedBy: 'explicit_reference',
    }],
    input_requirements: [{
      key: 'research_goal', kind: 'value', label: '研究目标', description: '研究目标',
      required: true, multiple: false, acceptedSources: ['conversation'], question: '研究什么？',
    }],
    input_requirements_hash: digest('inputs'),
    tool_bindings: [],
    report_policy: {
      kind: 'skill_defined',
      outputFormat: 'markdown',
      instructions: reference,
      instructionsHash: digest(reference),
    },
  };
}

const source = {
  id: 'S-1', title: 'Source', type: 'tool_result' as const, url: 'https://example.com/source',
};

function primary(content = '# Result\n\nEvidence [S-1].') {
  return { format: 'markdown' as const, content, contentHash: digest(content) };
}

test('freezes strict native package, result, and final-report contracts', () => {
  const result = parseNativeSkillResult({
    version: NATIVE_SKILL_RESULT_VERSION,
    skillId: 'native-test',
    invocationId: 'inv-native',
    title: 'Native result',
    status: 'completed',
    primary: primary(),
    attachments: [],
    sources: [source],
    gaps: [],
  });
  assert.equal(result.primary.format, 'markdown');

  const final = parseNativeFinalReport({
    version: NATIVE_FINAL_REPORT_VERSION,
    taskId: 'task-1', planVersionId: 'plan-1', attemptId: 'attempt-1',
    mode: 'single_skill', title: 'Final', primary: primary(), attachments: [],
    sources: [source], gaps: [],
    skillResults: [{
      skillId: 'native-test', invocationId: 'inv-native', status: 'completed',
      path: 'skill-results/inv-native.json',
    }],
  });
  assert.equal(final.skillResults.length, 1);
});

test('parses the historical final report as a distinct read-only contract', () => {
  const report = parseHistoricalFinalReportV1({
    version: HISTORICAL_FINAL_REPORT_VERSION,
    taskId: 'task-1',
    planVersionId: 'plan-1',
    attemptId: 'attempt-1',
    mode: 'single_skill',
    title: 'Historical report',
    markdown: '# Historical report',
    sources: [source],
    gaps: [],
    skillReports: [{
      skillId: 'native-test',
      invocationId: 'inv-native',
      status: 'completed',
      path: 'skill-results/inv-native.json',
    }],
  });
  assert.equal(report.version, HISTORICAL_FINAL_REPORT_VERSION);
  assert.equal(report.markdown, '# Historical report');
  assert.throws(() => parseHistoricalFinalReportV1({
    ...report,
    sources: [{ ...source, url: 'http://example.com/source' }],
  }), /sources\[0\]\.url/u);
  assert.throws(() => parseHistoricalFinalReportV1({
    ...report,
    skillReports: [{ ...report.skillReports[0], path: '../report.json' }],
  }), /skillReports\[0\]\.path/u);
});

test('rejects native output and attachment hash drift', () => {
  assert.throws(() => parseNativeSkillResult({
    version: NATIVE_SKILL_RESULT_VERSION,
    skillId: 'native-test', invocationId: 'inv-native', title: 'Native result', status: 'completed',
    primary: { ...primary(), contentHash: digest('different') },
    attachments: [], sources: [], gaps: [],
  }), /contentHash/u);
  assert.throws(() => parseNativeSkillResult({
    version: NATIVE_SKILL_RESULT_VERSION,
    skillId: 'native-test', invocationId: 'inv-native', title: 'Native result', status: 'completed',
    primary: primary(),
    attachments: [{ path: '../escape.md', mediaType: 'text/markdown', content: 'bad', contentHash: digest('bad') }],
    sources: [], gaps: [],
  }), /path/u);
});

test('parses only the explicit native execution-plan discriminator', () => {
  const spec = runSpec();
  const value = {
    task_id: 'task-1',
    execution_contract_version: NATIVE_SKILL_EXECUTION_PLAN_VERSION,
    mode: 'single_skill',
    deliverable_type: 'native_result',
    evidence_requirements: [],
    problem_graph: {},
    problem_graph_provenance: {},
    capability_decisions: {},
    steps: [{
      step_no: 1, step_name: 'native-test', actor_type: 'skill', actor_id: 'native-test',
      question_ids: [], depends_on: [], input: { research_goal: 'goal' }, input_bindings: [],
      expected_outputs: [], acceptance_criteria: [], requires_approval: false, fallback_actor_ids: [],
      skill_invocation_id: 'inv-native',
    }],
    candidate_metadata: {},
    activated_nodes: [],
    skill_invocations: [{
      invocation_id: 'inv-native', skill_id: 'native-test', depends_on_invocation_ids: [],
      step_nos: [1], required: true, failure_policy: 'block', run_spec: spec,
    }],
    final_report_policy: spec.report_policy,
    resolved_inputs: {
      resolved: [{
        key: 'research_goal', valueRef: 'requirement:/research_goal', source: 'conversation',
        targetInvocationIds: ['inv-native'],
      }],
      pending: [], waived: [],
    },
  };
  const plan = parseNativeSkillExecutionPlanV1(value);
  assert.equal(plan.skill_invocations[0]?.run_spec.package_hash, spec.package_hash);
  assert.throws(
    () => parseNativeSkillExecutionPlanV1({ ...value, execution_contract_version: 'lightweight-execution-plan-v1' }),
    /execution_contract_version/u,
  );
});

test('preserves a Skill-defined report and uses one default writer only when requested', async () => {
  const result = createNativeSkillResult({
    skillId: 'native-test',
    invocationId: 'inv-native',
    draft: {
      title: 'Native result', status: 'completed',
      primary: { format: 'markdown', content: '# Original structure\n\nEvidence [S-1].' },
      attachments: [], gaps: [],
    },
    sources: [source],
  });
  let calls = 0;
  const writer: NativeReportWriter = {
    async write() {
      calls += 1;
      return '# Dynamic report\n\nEvidence [S-1].';
    },
  };
  const direct = await finalizeSingleNativeReport({
    taskId: 'task-1', planVersionId: 'plan-1', attemptId: 'attempt-1',
    requirement: {}, result, verifiedSources: [source], reportPolicy: 'skill_defined',
  });
  assert.match(direct.primary.content, /^# Original structure/u);
  assert.equal(calls, 0);

  const dynamic = await finalizeSingleNativeReport({
    taskId: 'task-1', planVersionId: 'plan-1', attemptId: 'attempt-1',
    requirement: {}, result, verifiedSources: [source], reportPolicy: 'default_llm', defaultWriter: writer,
  });
  assert.match(dynamic.primary.content, /^# Dynamic report/u);
  assert.equal(calls, 1);
});

test('renders a NativeReportDocument without a second report call', async () => {
  const reportDocument = {
    version: 'native-report-document-v1' as const,
    title: '行业分析',
    assetIds: [],
    tabs: [{
      id: 'insight',
      title: '行业洞察',
      sections: [{
        id: 'overview',
        title: '核心判断',
        blocks: [{ type: 'markdown' as const, content: '结论 [S-1]。', sourceIds: ['S-1'] }],
      }],
    }],
  };
  const result = createNativeSkillResult({
    taskId: 'task-1',
    skillId: 'industry-market-analysis',
    invocationId: 'inv-industry',
    draft: {
      title: '行业分析',
      status: 'completed',
      reportDocument,
      attachments: [],
      gaps: [],
    },
    sources: [source],
  });
  assert.equal(result.primary.format, 'html');
  assert.match(result.primary.content, /行业洞察/u);
  assert.deepEqual(result.reportDocument, reportDocument);

  const final = await finalizeSingleNativeReport({
    taskId: 'task-1', planVersionId: 'plan-1', attemptId: 'attempt-1',
    requirement: {}, result, verifiedSources: [source], reportPolicy: 'skill_defined',
  });
  assert.deepEqual(final.reportDocument, reportDocument);
  assert.equal(final.reportDocumentHash, result.reportDocumentHash);
  assert.match(renderNativeFinalReportHtml(final), /type="radio"/u);
  assert.throws(() => parseNativeSkillResult({
    ...result,
    reportDocument: { ...reportDocument, title: '被篡改的标题' },
  }), /reportDocumentHash/u);
});

test('mock HTML-policy Skill output follows the ReportDocument schema', async () => {
  const generated = await new MockLLMClient().generateStructured({
    prompt: '本次正式报告必须填写 reportDocument',
    schema: NATIVE_SKILL_RESULT_DRAFT_SCHEMA,
    schemaName: 'skill:industry-market-analysis',
    context: {},
    receipt: { stage: 'skill' },
  });
  new SchemaValidator().validateSchemaOrThrow(
    NATIVE_SKILL_RESULT_DRAFT_SCHEMA,
    generated.data,
    'skill:industry-market-analysis',
  );
  const document = (generated.data as { reportDocument?: { version?: string; tabs?: unknown[] } }).reportDocument;
  assert.equal(document?.version, 'native-report-document-v1');
  assert.equal(document?.tabs?.length, 5);
});

test('removes unverified generated links deterministically and records a Gap', () => {
  const result = createNativeSkillResult({
    skillId: 'native-test', invocationId: 'inv-native',
    draft: {
      title: 'Safe result', status: 'completed',
      primary: { format: 'markdown', content: 'Keep [S-1], remove [internal](http://internal.example/path).' },
      attachments: [], gaps: [],
    },
    sources: [source],
  });
  assert.doesNotMatch(result.primary.content, /internal\.example/u);
  assert.match(result.gaps.join(' '), /未验证来源引用已移除/u);
  assert.equal(result.status, 'completed_with_gaps');
});

test('renders Markdown tables, emphasis, and dividers as structured HTML', async () => {
  const result = createNativeSkillResult({
    skillId: 'native-test', invocationId: 'inv-table',
    draft: {
      title: '表格报告', status: 'completed',
      primary: {
        format: 'markdown',
        content: '# 结论\n\n**重点**\n\n| 问题 | 建议 |\n|---|---|\n| 信息层级 | 精简首屏 |\n\n---\n',
      },
      attachments: [], gaps: [],
    },
    sources: [],
  });
  const report = await finalizeSingleNativeReport({
    taskId: 'task-table', planVersionId: 'plan-table', attemptId: 'attempt-table',
    requirement: {}, result, verifiedSources: [], reportPolicy: 'skill_defined',
  });
  const html = renderNativeFinalReportHtml(report);
  assert.match(html, /<table>/u);
  assert.match(html, /<th>问题<\/th>/u);
  assert.match(html, /<td>精简首屏<\/td>/u);
  assert.match(html, /<strong>重点<\/strong>/u);
  assert.match(html, /<hr>/u);
});

test('performs one structured Multi synthesis and sanitizes historical Skill HTML', async () => {
  const result = createNativeSkillResult({
    skillId: 'native-test', invocationId: 'inv-native',
    draft: {
      title: 'Native result', status: 'completed',
      primary: {
        format: 'markdown',
        content: '# Result\n\nEvidence [S-1].',
      },
      attachments: [], gaps: [],
    }, sources: [source],
  });
  const sanitizedHtml = sanitizeNativeHtml([
    '<h1>Result</h1>',
    '<script>alert(1)</script>',
    '<a href=javascript:alert(1)>bad</a>',
    '<svg><a xlink:href="https://evil.test/x">bad</a></svg>',
    '<img src="https://evil.test/a.png" srcset="https://evil.test/b.png 2x">',
  ].join(''), [source]);
  assert.doesNotMatch(sanitizedHtml, /script|javascript:|xlink:href|srcset|evil\.test/u);
  let calls = 0;
  const writer: NativeReportWriter = {
    async write() {
      calls += 1;
      return {
        version: 'native-report-document-v1',
        title: 'Combined',
        assetIds: [],
        tabs: [{
          id: 'summary', title: '综合结论', sections: [{
            id: 'findings', title: '关键发现',
            blocks: [{ type: 'markdown', content: 'Evidence [S-1].', sourceIds: ['S-1'] }],
          }],
        }],
      };
    },
  };
  const multi = await finalizeMultiNativeReport({
    taskId: 'task-1', planVersionId: 'plan-1', attemptId: 'attempt-1', title: 'Combined',
    requirement: {}, results: [result], verifiedSources: [source], writer,
    reportPolicy: {
      kind: 'skill_defined', outputFormat: 'html', instructions: 'Use structured report.',
      instructionsHash: digest('Use structured report.'),
    },
  });
  assert.equal(calls, 1);
  assert.equal(multi.report.primary.format, 'html');
  const rendered = renderNativeFinalReportHtml(multi.report);
  assert.match(rendered, /Combined/u);
  assert.match(rendered, /Content-Security-Policy/u);
  assert.equal((rendered.match(/<html\b/giu) ?? []).length, 1);
  assert.equal((rendered.match(/<head\b/giu) ?? []).length, 1);
});

test('rejects package manifests, references, and report policies that drift', () => {
  const spec = runSpec();
  const base = {
    task_id: 'task-1', execution_contract_version: NATIVE_SKILL_EXECUTION_PLAN_VERSION,
    mode: 'single_skill', deliverable_type: 'native_result', evidence_requirements: [],
    problem_graph: {}, problem_graph_provenance: {}, capability_decisions: {},
    steps: [{
      step_no: 1, step_name: 'native-test', actor_type: 'skill', actor_id: 'native-test', question_ids: [],
      depends_on: [], input: {}, input_bindings: [], expected_outputs: [], acceptance_criteria: [],
      requires_approval: false, fallback_actor_ids: [], skill_invocation_id: 'inv-native',
    }], candidate_metadata: {}, activated_nodes: [],
    resolved_inputs: { resolved: [], pending: [], waived: [] },
    final_report_policy: spec.report_policy,
  };
  const invocation = {
    invocation_id: 'inv-native', skill_id: 'native-test', depends_on_invocation_ids: [],
    step_nos: [1], required: true, failure_policy: 'block', run_spec: spec,
  };
  for (const badSpec of [
    { ...spec, package_hash: digest('wrong') },
    { ...spec, selected_references: [{ ...spec.selected_references[0]!, content: 'changed' }] },
    { ...spec, report_policy: { kind: 'skill_defined', outputFormat: 'markdown', instructions: 'changed', instructionsHash: digest('wrong') } },
  ]) {
    assert.throws(
      () => parseNativeSkillExecutionPlanV1({ ...base, skill_invocations: [{ ...invocation, run_spec: badSpec }] }),
    );
  }
});
