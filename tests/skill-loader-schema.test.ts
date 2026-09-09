import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SkillLoader } from '../apps/orchestrator-runtime/src/runtime/skill-loader.ts';
import {
  getConfigRoot,
  setConfigRoot,
  type SkillCapability,
} from '../apps/orchestrator-runtime/src/runtime/config-loader.ts';

// 所有 active Skill 使用统一结果信封；领域 payload schema 在执行期内联。

const sl = new SkillLoader();
const realRoot = getConfigRoot();

function withSkillBinding(skill: object, run: () => void): void {
  const root = mkdtempSync(join(tmpdir(), 'skill-loader-registry-'));
  mkdirSync(join(root, 'orchestrator'), { recursive: true });
  const skillId = typeof (skill as { id?: unknown }).id === 'string'
    ? (skill as { id: string }).id
    : 'fixture-skill';
  const packageRoot = join(root, 'skills', skillId);
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, 'SKILL.md'), `---\nname: ${skillId}\ndescription: Fixture Skill.\n---\n# Fixture\n`);
  const value = skill as Record<string, unknown>;
  const binding = Object.fromEntries(Object.entries(value).filter(([key]) => [
    'id', 'task_types', 'inputs', 'input_requirements', 'visual_inputs', 'multiple_visual_inputs',
    'dataset_inputs', 'required_tools', 'optional_tools', 'risk_level', 'composition',
  ].includes(key)));
  writeFileSync(
    join(root, 'orchestrator', 'skill-bindings.yaml'),
    JSON.stringify({ version: 1, skills: [{ ...binding, enabled: value.status === 'active' }] }),
  );
  writeFileSync(
    join(root, 'orchestrator', 'tool-registry.yaml'),
    JSON.stringify({ version: 1, tools: [
      { id: 'vision-tool', status: 'active' },
      { id: 'playwright-page-capture', status: 'draft' },
    ] }),
  );
  try {
    setConfigRoot(root);
    run();
  } finally {
    setConfigRoot(realRoot);
    rmSync(root, { recursive: true, force: true });
  }
}

const capabilitySkill: SkillCapability = {
  id: 'visual-skill',
  name: 'visual skill',
  path: 'skills/visual/SKILL.md',
  when_to_use: 'visual review',
  owner: 'design',
  status: 'active',
  task_types: ['design_audit'],
  inputs: ['designImage'],
  visual_inputs: ['designImage'],
  multiple_visual_inputs: ['designImage'],
  outputs: ['design_review'],
  output_schema: 'schemas/skill-result-envelope.schema.json',
  required_tools: ['vision-tool'],
  risk_level: 'low',
};

test('loadSkillSchemas:KB Skill 无 input schema 但有统一输出合同', () => {
  const s = sl.loadSkillSchemas('competitive-analysis');
  assert.equal(s.input, undefined, 'KB skill 无 input_schema → undefined');
  assert.equal(typeof s.output, 'object');
});

test('loadSkillBody reads through an immutable package snapshot', () => {
  const packageSnapshot = sl.loadSkillPackage('competitive-analysis');
  const body = sl.loadSkillBody('competitive-analysis');
  assert.ok(body.body.length > 0, '应读到 SKILL.md 正文');
  assert.ok(body.hash.startsWith('sha256:'), '应有 entry file hash');
  assert.ok(body.path.endsWith('SKILL.md'), 'path 应指向 SKILL.md 文件');
  assert.match(packageSnapshot.packageHash, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(packageSnapshot.files.some(({ path }) => path === packageSnapshot.entryPath), true);
});

test('all active Skills expose immutable package metadata', () => {
  const loader = new SkillLoader();
  for (const skill of loader.listActiveSkills()) {
    const snapshot = loader.loadSkillPackage(skill.id);
    assert.match(snapshot.packageHash, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(snapshot.files.some(({ path }) => path === snapshot.entryPath), true);
    assert.equal(snapshot.files.every(({ path }) => !path.startsWith('/') && !path.includes('..')), true);
  }
});

test('builds a native run spec from the unchanged package and explicit references', () => {
  const spec = sl.loadNativeRunSpec('competitive-analysis');
  assert.equal(spec.skill_id, 'competitive-analysis');
  assert.match(spec.package_hash, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(spec.entry_path, 'SKILL.md');
  assert.equal(spec.files.some(({ path }) => path === spec.entry_path), true);
  assert.equal(spec.selected_references.length > 0, true);
  assert.equal(spec.selected_references.every(({ logicalPath }) => (
    logicalPath.startsWith('skill://competitive-analysis/')
    || logicalPath.startsWith('knowledge://research-wiki/')
  )), true);
  assert.equal(spec.report_policy.kind, 'skill_defined');
});

test('injects explicitly referenced internal research wiki files into a native run spec', () => {
  const spec = sl.loadNativeRunSpec('run-heuristic-evaluation', {
    task_type: 'design_audit',
    research_goal: '评估京东图书频道界面',
  });
  const mountedPaths = spec.selected_references
    .filter(({ source }) => source === 'knowledge_mount')
    .map(({ path }) => path);
  assert.equal(spec.input_requirements.some(({ key }) => key === 'designImage'), false);
  assert.deepEqual(
    spec.input_requirements.filter(({ key }) => key === 'page_url' || key === 'jd_screenshots')
      .map(({ key, kind, label }) => ({ key, kind, label })),
    [
      { key: 'page_url', kind: 'value', label: '待评估页面链接' },
      { key: 'jd_screenshots', kind: 'visual', label: '京东页面截图' },
    ],
  );
  assert.ok(mountedPaths.includes('models/nielsen-heuristics.md'));
  assert.ok(mountedPaths.includes('methods/toolbox/collection/heuristic-evaluation.md'));
  assert.ok(mountedPaths.includes('methods/toolbox/analysis/issue-prioritization.md'));
  assert.equal(spec.report_policy.kind, 'skill_defined');
  if (spec.report_policy.kind === 'skill_defined') {
    assert.match(spec.report_policy.instructions, /问题清单/u);
    assert.doesNotMatch(spec.report_policy.instructions, /# Run Heuristic Evaluation/u);
  }
});

test('loads the original Industry package without a platform-rewritten copy', () => {
  const loader = new SkillLoader();
  const snapshot = loader.loadSkillPackage('industry-market-analysis');
  const runSpec = loader.loadNativeRunSpec('industry-market-analysis', {
    industry_scope: { analysis_depth: 'medium' },
  });
  assert.equal(snapshot.files.length, 28);
  assert.equal(runSpec.files.length, 28);
  assert.equal(runSpec.report_policy.kind, 'skill_defined');
  if (runSpec.report_policy.kind === 'skill_defined') {
    assert.match(runSpec.report_policy.instructions, /报告模板-中档|三档合一|TL;DR/u);
  }
  assert.equal(runSpec.selected_references.some(({ path }) => path.includes('三档深度对照表')), true);
  assert.equal(runSpec.selected_references.some(({ path }) => path.endsWith('报告模板-中档.md')), true);
  assert.equal(runSpec.selected_references.some(({ path }) => path.endsWith('报告模板-轻档.md')), false);
  assert.equal(runSpec.selected_references.some(({ path }) => path.endsWith('报告模板-重档.md')), false);
  assert.deepEqual(
    runSpec.input_requirements.find(({ key }) => key === 'internal_documents'),
    {
      key: 'internal_documents',
      kind: 'document',
      label: '内部业务材料',
      description: '内部业务材料，用于完成本次分析。',
      required: false,
      multiple: true,
      acceptedSources: ['upload'],
      question: '请提供内部业务材料。',
    },
  );
});

test('active material Skills expose upload controls that match their declared data shape', () => {
  const expected = [
    ['analyze-satisfaction', 'analytics_dataset', 'dataset'],
    ['build-experience-metrics', 'analytics_dataset', 'dataset'],
    ['conversion-funnel-analysis', 'analytics_dataset', 'dataset'],
    ['feature-adoption-analysis', 'analytics_dataset', 'dataset'],
    ['competitive-analysis', 'user_materials', 'document'],
    ['generate-persona', 'user_materials', 'document'],
    ['generate-persona', 'qualitative_insights', 'document'],
    ['generate-persona', 'user_research_dataset', 'dataset'],
    ['jobs-to-be-done', 'user_materials', 'document'],
    ['jobs-to-be-done', 'qualitative_insights', 'document'],
    ['journey-map', 'user_materials', 'document'],
  ] as const;

  for (const [skillId, key, kind] of expected) {
    const requirement = sl.loadNativeRunSpec(skillId).input_requirements.find((item) => item.key === key);
    assert.deepEqual(
      requirement && { kind: requirement.kind, acceptedSources: requirement.acceptedSources },
      { kind, acceptedSources: ['upload'] },
      `${skillId}.${key}`,
    );
  }
});

test('loadSkillSchemas keeps only the universal output schema outside the Skill package', () => {
  const schemas = sl.loadSkillSchemas('digital-human-competitive-analysis');
  assert.equal(schemas.input, undefined);
  assert.equal(typeof schemas.output, 'object');
  assert.ok(schemas.output !== null);
  const properties = (schemas.output as { properties?: Record<string, unknown> }).properties;
  assert.ok(properties?.payload);
  assert.equal(properties?.comparison_matrix, undefined);
});

test('image-named input roles are exposed as visual uploads', () => {
  for (const skill of sl.listCapabilitySkills()) {
    const declaredRoles = [...new Set([
      ...(skill.inputs ?? []),
      ...(skill.composition?.required_input_roles ?? []),
      ...(skill.composition?.optional_input_roles ?? []),
    ])];
    const unclassified = declaredRoles.filter((role) => (
      /(?:image|images|screenshot|screenshots)$/iu.test(role)
      && !(skill.visual_inputs ?? []).includes(role)
    ));
    assert.deepEqual(unclassified, [], skill.id);
  }
});

test('listCapabilitySkills preserves valid visual input metadata', () => {
  withSkillBinding(capabilitySkill, () => {
    assert.deepEqual(new SkillLoader().listCapabilitySkills()[0]?.visual_inputs, ['designImage']);
    assert.deepEqual(new SkillLoader().listCapabilitySkills()[0]?.multiple_visual_inputs, ['designImage']);
    assert.deepEqual(new SkillLoader().listCapabilitySkills()[0]?.optional_tools, []);
  });
});

test('getRegisteredTool reads frozen optional tools without making drafts routable', () => {
  assert.equal(sl.getTool('playwright-page-capture'), null);
  assert.equal(sl.getRegisteredTool('playwright-page-capture')?.status, 'draft');
});

test('listCapabilitySkills preserves optional tools and rejects malformed or overlapping declarations', () => {
  withSkillBinding({
    ...capabilitySkill,
    optional_tools: ['playwright-page-capture'],
  }, () => {
    assert.deepEqual(
      new SkillLoader().listCapabilitySkills()[0]?.optional_tools,
      ['playwright-page-capture'],
    );
  });

  for (const skill of [
    { ...capabilitySkill, optional_tools: 'playwright-page-capture' },
    { ...capabilitySkill, optional_tools: ['playwright-page-capture', 'playwright-page-capture'] },
    { ...capabilitySkill, optional_tools: [' '] },
    { ...capabilitySkill, optional_tools: ['vision-tool'] },
  ]) {
    withSkillBinding(skill, () => {
      assert.throws(
        () => new SkillLoader().listCapabilitySkills(),
        /active skill capability metadata invalid/u,
      );
    });
  }
});

test('listCapabilitySkills rejects malformed visual input bindings', () => {
  const malformed: Array<Record<string, unknown>> = [
    { ...capabilitySkill, visual_inputs: 'designImage' },
    { ...capabilitySkill, visual_inputs: [' '] },
    { ...capabilitySkill, visual_inputs: ['designImage', 'designImage'] },
    { ...capabilitySkill, visual_inputs: ['competitorImage'] },
    { ...capabilitySkill, multiple_visual_inputs: 'designImage' },
    { ...capabilitySkill, multiple_visual_inputs: ['competitorImage'] },
  ];
  for (const skill of malformed) {
    withSkillBinding(skill, () => {
      assert.throws(
        () => new SkillLoader().listCapabilitySkills(),
        /active skill capability metadata invalid/u,
      );
    });
  }
});
