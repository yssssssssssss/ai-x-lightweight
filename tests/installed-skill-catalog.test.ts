import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { InstalledSkillCatalog } from '../apps/orchestrator-runtime/src/runtime/installed-skill-catalog.ts';
import { SkillLoader } from '../apps/orchestrator-runtime/src/runtime/skill-loader.ts';
import { getConfigRoot, setConfigRoot } from '../apps/orchestrator-runtime/src/runtime/config-loader.ts';

test('discovers the unchanged project Skill packages deterministically and caches one process snapshot', () => {
  const catalog = new InstalledSkillCatalog();
  const snapshot = catalog.scan();
  assert.equal(catalog.scan(), snapshot);
  assert.equal(snapshot.skills.length, 26);
  assert.equal(snapshot.skills.filter(({ readiness }) => readiness === 'ready').length, 25);
  assert.equal(snapshot.skills.find(({ id }) => id === 'solution-generation')?.readiness, 'blocked');
  assert.match(snapshot.catalogHash, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(snapshot.skills.map(({ id }) => id), [...snapshot.skills.map(({ id }) => id)].sort());
});

test('discovers unchanged packages from an additional configured root', () => {
  const root = mkdtempSync(join(tmpdir(), 'installed-skill-extra-root-'));
  const packageRoot = join(root, 'external-skill');
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, 'SKILL.md'), '# External Skill\n\nAnalyze the request.\n');
  const previous = process.env.SKILL_PACKAGE_ROOTS;
  process.env.SKILL_PACKAGE_ROOTS = JSON.stringify([root]);
  try {
    assert.ok(new InstalledSkillCatalog().get('external-skill'));
  } finally {
    if (previous === undefined) delete process.env.SKILL_PACKAGE_ROOTS;
    else process.env.SKILL_PACKAGE_ROOTS = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('freezes an instruction-only external Tool dependency as needs_binding', () => {
  const previousRoot = getConfigRoot();
  const root = mkdtempSync(join(tmpdir(), 'installed-skill-needs-binding-'));
  const packageRoot = join(root, 'skills', 'external-tool-skill');
  mkdirSync(packageRoot, { recursive: true });
  mkdirSync(join(root, 'orchestrator'), { recursive: true });
  writeFileSync(join(root, 'orchestrator', 'skill-bindings.yaml'), 'version: 1\nskills: []\n');
  writeFileSync(join(root, 'orchestrator', 'tool-registry.yaml'), 'version: 1\ntools: []\n');
  writeFileSync(join(packageRoot, 'SKILL.md'), [
    '---', 'name: external-tool-skill', 'description: Needs an external API.',
    '---', '# External', '', 'Use `missing-api` to retrieve required evidence.', '',
  ].join('\n'));
  try {
    setConfigRoot(root);
    const loader = new SkillLoader(new InstalledSkillCatalog([join(root, 'skills')]));
    const installed = loader.listInstalledSkills()[0];
    assert.equal(installed?.readiness, 'ready');
    assert.deepEqual(loader.loadNativeRunSpec('external-tool-skill').tool_bindings, [{
      capability: 'missing-api', toolId: 'missing-api', required: false, status: 'needs_binding',
    }]);
  } finally {
    setConfigRoot(previousRoot);
    rmSync(root, { recursive: true, force: true });
  }
});

test('marks a package needs_binding when frontmatter requires an unavailable Tool', () => {
  const previousRoot = getConfigRoot();
  const root = mkdtempSync(join(tmpdir(), 'installed-skill-required-tool-'));
  const packageRoot = join(root, 'skills', 'required-tool-skill');
  mkdirSync(packageRoot, { recursive: true });
  mkdirSync(join(root, 'orchestrator'), { recursive: true });
  writeFileSync(join(root, 'orchestrator', 'skill-bindings.yaml'), 'version: 1\nskills: []\n');
  writeFileSync(join(root, 'orchestrator', 'tool-registry.yaml'), 'version: 1\ntools: []\n');
  writeFileSync(join(packageRoot, 'SKILL.md'), [
    '---', 'name: required-tool-skill', 'description: Needs an external API.',
    'required_tools: [missing-api]', '---', '# External', '',
  ].join('\n'));
  try {
    setConfigRoot(root);
    const installed = new SkillLoader(new InstalledSkillCatalog([join(root, 'skills')]))
      .listInstalledSkills()[0];
    assert.equal(installed?.readiness, 'needs_binding');
    assert.deepEqual(installed?.missingCapabilities, ['missing-api']);
  } finally {
    setConfigRoot(previousRoot);
    rmSync(root, { recursive: true, force: true });
  }
});

test('uses the directory name when SKILL.md has no frontmatter', () => {
  const root = mkdtempSync(join(tmpdir(), 'installed-skills-'));
  const packageRoot = join(root, 'plain-skill');
  mkdirSync(packageRoot);
  writeFileSync(join(packageRoot, 'SKILL.md'), '# Plain skill\n\nUse this package for plain analysis.\n');
  try {
    const snapshot = new InstalledSkillCatalog([root]).scan();
    assert.equal(snapshot.skills[0]?.id, 'plain-skill');
    assert.match(snapshot.skills[0]?.description ?? '', /Use this package/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('makes an unmodified unregistered package directly callable', () => {
  const previousRoot = getConfigRoot();
  const root = mkdtempSync(join(tmpdir(), 'installed-skill-runtime-'));
  const packagesRoot = join(root, 'packages');
  const packageRoot = join(packagesRoot, 'drop-in-skill');
  mkdirSync(packageRoot, { recursive: true });
  mkdirSync(join(root, 'orchestrator'), { recursive: true });
  writeFileSync(join(root, 'orchestrator', 'skill-bindings.yaml'), 'version: 1\nskills: []\n');
  writeFileSync(join(root, 'orchestrator', 'tool-registry.yaml'), 'version: 1\ntools: []\n');
  writeFileSync(join(packageRoot, 'SKILL.md'), [
    '---',
    'name: drop-in-skill',
    'description: Analyze an arbitrary supplied research goal.',
    '---',
    '# Drop-in Skill',
    '## 输出',
    'Return a concise Markdown report.',
  ].join('\n'));
  try {
    setConfigRoot(root);
    const loader = new SkillLoader(new InstalledSkillCatalog([packagesRoot]));
    assert.deepEqual(loader.listActiveSkills().map(({ id }) => id), ['drop-in-skill']);
    assert.equal(loader.getSkill('drop-in-skill')?.entry, join(realpathSync(packageRoot), 'SKILL.md'));
    const runSpec = loader.loadNativeRunSpec('drop-in-skill');
    assert.equal(runSpec.report_policy.kind, 'skill_defined');
    assert.equal(
      loader.loadNativeRunSpec('drop-in-skill', { output: 'HTML 报告' }).report_policy.outputFormat,
      'html',
    );
    assert.deepEqual(runSpec.input_requirements.map(({ key }) => key), ['research_goal']);
  } finally {
    setConfigRoot(previousRoot);
    rmSync(root, { recursive: true, force: true });
  }
});

test('uses the default report policy when an unchanged package defines no output structure', () => {
  const previousRoot = getConfigRoot();
  const root = mkdtempSync(join(tmpdir(), 'installed-skill-default-report-'));
  const packagesRoot = join(root, 'packages');
  const packageRoot = join(packagesRoot, 'analysis-only');
  mkdirSync(packageRoot, { recursive: true });
  mkdirSync(join(root, 'orchestrator'), { recursive: true });
  writeFileSync(join(root, 'orchestrator', 'skill-bindings.yaml'), 'version: 1\nskills: []\n');
  writeFileSync(join(root, 'orchestrator', 'tool-registry.yaml'), 'version: 1\ntools: []\n');
  writeFileSync(join(packageRoot, 'SKILL.md'), '---\nname: analysis-only\ndescription: Analyze the supplied material.\n---\n# Analysis\nIdentify the important evidence.\n');
  try {
    setConfigRoot(root);
    const loader = new SkillLoader(new InstalledSkillCatalog([packagesRoot]));
    const runSpec = loader.loadNativeRunSpec('analysis-only');
    assert.equal(runSpec.report_policy.kind, 'default_llm');
  } finally {
    setConfigRoot(previousRoot);
    rmSync(root, { recursive: true, force: true });
  }
});

test('requires clarification and Replan for an ambiguous multi-template package', () => {
  const previousRoot = getConfigRoot();
  const root = mkdtempSync(join(tmpdir(), 'installed-skill-report-choice-'));
  const packagesRoot = join(root, 'packages');
  const packageRoot = join(packagesRoot, 'report-choice');
  mkdirSync(join(packageRoot, 'references'), { recursive: true });
  mkdirSync(join(root, 'orchestrator'), { recursive: true });
  writeFileSync(join(root, 'orchestrator', 'skill-bindings.yaml'), 'version: 1\nskills: []\n');
  writeFileSync(join(root, 'orchestrator', 'tool-registry.yaml'), 'version: 1\ntools: []\n');
  writeFileSync(join(packageRoot, 'SKILL.md'), [
    '---', 'name: report-choice', 'description: Select a report.', '---',
    '# Report choice', 'Use `references/report-template-alpha.md` or `references/report-template-beta.md`.',
  ].join('\n'));
  writeFileSync(join(packageRoot, 'references', 'report-template-alpha.md'), '# Alpha report\n');
  writeFileSync(join(packageRoot, 'references', 'report-template-beta.md'), '# Beta report\n\nThe report must output HTML.\n');
  try {
    setConfigRoot(root);
    const loader = new SkillLoader(new InstalledSkillCatalog([packagesRoot]));
    assert.throws(
      () => loader.loadNativeRunSpec('report-choice', { research_goal: 'No format preference' }),
      /selection requires clarification and Replan/u,
    );
    const selected = loader.loadNativeRunSpec('report-choice', { report_template: 'report template beta' });
    assert.deepEqual(
      selected.selected_references.filter(({ path }) => path.includes('report-')).map(({ path }) => path),
      ['references/report-template-beta.md'],
    );
    assert.equal(selected.report_policy.outputFormat, 'html');
  } finally {
    setConfigRoot(previousRoot);
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects duplicate package IDs and catalog symlinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'installed-skills-'));
  const first = join(root, 'one');
  const second = join(root, 'two');
  mkdirSync(first);
  mkdirSync(second);
  writeFileSync(join(first, 'SKILL.md'), '---\nname: duplicate\n---\n# One\n');
  writeFileSync(join(second, 'SKILL.md'), '---\nname: duplicate\n---\n# Two\n');
  try {
    assert.throws(() => new InstalledSkillCatalog([root]).scan(), /duplicate package id/u);
    rmSync(second, { recursive: true, force: true });
    symlinkSync(first, join(root, 'linked'));
    assert.throws(() => new InstalledSkillCatalog([root]).scan(), /symbolic link/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
