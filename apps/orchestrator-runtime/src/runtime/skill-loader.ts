import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  DEFAULT_REPORT_PROMPT,
  DEFAULT_REPORT_PROMPT_VERSION,
  parseSkillInputRequirements,
  type NativeSkillRunSpec,
  type SkillInputRequirement,
} from '../../../../packages/api-contract/native-skill-orchestration.ts';
import type { LoadedSkillExecutionContract } from '../skills/skill-execution-contract.ts';
import {
  readSkillPackageText,
  type SkillPackageSnapshot,
} from './skill-package.ts';
import { InstalledSkillCatalog, type InstalledSkill } from './installed-skill-catalog.ts';
import { KnowledgeMountRegistry } from './knowledge-mount.ts';
import {
  loadSkillBindings,
  loadToolRegistry,
  getConfigRoot,
  SKILL_RESULT_ENVELOPE_SCHEMA,
  skillDatasetInputIssue,
  skillDocumentInputIssue,
  skillOptionalToolIssue,
  skillVisualInputIssue,
  unknownSkillBindingFields,
  type SkillCapability,
  type ToolRegistryEntry,
} from './config-loader.ts';

// 三层渐进加载:
//   第一层 原版包目录 + 平台 binding 摘要 → 发现候选,避免上下文膨胀
//   第二层 原版包:SKILL.md + 完整文件清单/hash → 冻结包身份并发现相对引用
//   第三层 执行期资源:只读取 Plan 选择的 references 与外部能力
// 只加载 ready 能力；needs_binding/blocked 不参与自动路由。

export interface SkillCandidate {
  entry: SkillCapability;
  manifestHash: string;
}

type CapabilityArrays = {
  task_types: string[];
  inputs: string[];
  outputs: string[];
  required_tools: string[];
  optional_tools: string[];
};

type ActiveCapabilitySkill = Omit<
  SkillCapability,
  'status' | keyof CapabilityArrays
> & CapabilityArrays & { status: 'active' };

type InactiveCapabilitySkill = Partial<Omit<
  SkillCapability,
  'status' | keyof CapabilityArrays
>> & CapabilityArrays & { status: 'draft' | 'deprecated' };

export type CapabilitySkill =
  | ActiveCapabilitySkill
  | InactiveCapabilitySkill;

export interface LoadedSkillSchemas {
  input?: object;
  output: object;
}

export function composeSkillOutputSchema(envelope: object, payload?: object): object {
  const output = structuredClone(envelope) as Record<string, unknown>;
  delete output.$id;
  if (!payload) return output;
  const properties = output.properties;
  if (
    properties === null
    || typeof properties !== 'object'
    || Array.isArray(properties)
    || !Object.hasOwn(properties, 'payload')
  ) {
    throw new Error('Skill output envelope must declare a payload property');
  }
  Reflect.set(properties, 'payload', structuredClone(payload));
  return output;
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

const INPUT_LABELS: Readonly<Record<string, string>> = {
  research_goal: '研究目标',
  page_url: '待评估页面链接',
  designImage: '设计稿或页面截图',
  jd_screenshots: '京东页面截图',
  competitor_screenshots: '竞品页面截图',
  competitor_platform_names: '竞品平台名称',
  user_research_dataset: '用户研究数据',
  internal_metrics_dataset: '内部指标数据',
  analytics_dataset: '分析数据',
  internal_documents: '内部业务材料',
  user_materials: '用户材料',
  qualitative_insights: '定性研究洞察',
};

function inputLabel(key: string): string {
  return INPUT_LABELS[key] ?? '补充材料';
}

function contextText(value: unknown): string {
  try {
    return JSON.stringify(value ?? '').toLocaleLowerCase('en-US');
  } catch {
    return String(value ?? '').toLocaleLowerCase('en-US');
  }
}

function selectReportTemplatePaths(
  candidates: readonly string[],
  context: unknown,
): string[] {
  if (candidates.length <= 1) return [...candidates];
  const text = contextText(context);
  const depth = typeof context === 'object' && context !== null
    && 'industry_scope' in context
    && typeof (context as { industry_scope?: unknown }).industry_scope === 'object'
    && (context as { industry_scope?: { analysis_depth?: unknown } }).industry_scope !== null
    ? (context as { industry_scope: { analysis_depth?: unknown } }).industry_scope.analysis_depth
    : undefined;
  const depthTerms = depth === 'light'
    ? ['light', '轻档']
    : depth === 'medium'
      ? ['medium', '中档']
      : depth === 'heavy' ? ['heavy', '重档'] : [];
  const scored = candidates.map((path) => {
    const normalized = path.toLocaleLowerCase('en-US');
    const directTokens = text.match(/[\p{L}\p{N}]{2,}/gu) ?? [];
    const score = directTokens.filter((token) => normalized.includes(token)).length
      + (depthTerms.some((term) => normalized.includes(term)) ? 100 : 0)
      + (/三档合一/u.test(path) && /(?:一次产出|三档合一)/u.test(text) ? 100 : 0);
    return { path, score };
  }).sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
  if (scored[0]!.score === 0 || scored[0]!.score === scored[1]!.score) {
    throw new Error(
      `report template selection requires clarification and Replan: ${candidates.join(', ')}`,
    );
  }
  return [scored[0]!.path];
}

function referencedToolIds(
  body: string,
  declared: readonly string[],
  registered: readonly ToolRegistryEntry[],
): string[] {
  const ids = new Set(declared);
  for (const tool of registered) {
    if (body.includes(tool.id)) ids.add(tool.id);
  }
  for (const match of body.matchAll(/`([a-z0-9]+(?:-[a-z0-9]+)*(?:-api|-search|-lab|-tool))`/gu)) {
    ids.add(match[1]!);
  }
  return [...ids].sort();
}

export class SkillLoader {
  constructor(
    private readonly installedCatalog = new InstalledSkillCatalog(),
    private readonly knowledgeMounts = KnowledgeMountRegistry.fromEnvironment(),
  ) {}

  listInstalledSkills(): InstalledSkill[] {
    const bindings = new Map(loadSkillBindings().skills.map((binding) => [binding.id, binding]));
    const registeredTools = loadToolRegistry().tools;
    const activeTools = new Set(registeredTools
      .filter(({ status }) => status === 'active')
      .map(({ id }) => id));
    return this.installedCatalog.scan().skills.map((installed) => {
      if (installed.readiness === 'blocked') return installed;
      const binding = bindings.get(installed.id);
      const frontmatterTools = Array.isArray(installed.package.frontmatter.required_tools)
        ? installed.package.frontmatter.required_tools.filter((item): item is string => typeof item === 'string')
        : [];
      const requiredToolIds = [...new Set([...(binding?.required_tools ?? []), ...frontmatterTools])];
      const missingCapabilities = requiredToolIds.filter((toolId) => !activeTools.has(toolId));
      return missingCapabilities.length === 0
        ? installed
        : { ...installed, readiness: 'needs_binding', missingCapabilities };
    });
  }

  private installedSkillEntry(installed: InstalledSkill): SkillCapability {
    const binding = loadSkillBindings().skills.find(({ id }) => id === installed.id);
    const frontmatter = installed.package.frontmatter;
    const stringArray = (value: unknown): string[] => Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
    const enabled = binding?.enabled ?? installed.readiness === 'ready';
    return {
      id: installed.id,
      name: installed.displayName,
      path: installed.package.rootPath,
      entry: resolve(installed.package.rootPath, installed.package.entryPath),
      when_to_use: installed.description,
      owner: typeof frontmatter.owner === 'string' && frontmatter.owner.trim()
        ? frontmatter.owner.trim()
        : 'skill-package',
      status: enabled && installed.readiness === 'ready' ? 'active' : 'draft',
      task_types: binding?.task_types ?? [
        'a11y_audit',
        'competitive_research',
        'design_audit',
        'industry_market_analysis',
        'research_synthesis',
        'user_research_planning',
        'voc_diagnosis',
      ],
      inputs: binding?.inputs ?? ['research_goal'],
      input_requirements: binding?.input_requirements,
      visual_inputs: binding?.visual_inputs ?? [],
      multiple_visual_inputs: binding?.multiple_visual_inputs ?? [],
      dataset_inputs: binding?.dataset_inputs ?? [],
      document_inputs: binding?.document_inputs ?? [],
      outputs: ['native_result'],
      output_schema: SKILL_RESULT_ENVELOPE_SCHEMA,
      required_tools: binding?.required_tools ?? stringArray(frontmatter.required_tools),
      optional_tools: binding?.optional_tools ?? stringArray(frontmatter.optional_tools),
      risk_level: binding?.risk_level
        ?? (frontmatter.risk_level === 'high' || frontmatter.risk_level === 'medium'
          ? frontmatter.risk_level
          : 'low'),
      composition: binding?.composition,
    };
  }

  // 原版包目录是身份与内容真相源；平台 binding 仅补充启停、输入种类、Tool 与组合权限。
  listActiveSkills(): SkillCapability[] {
    return this.listInstalledSkills()
      .map((installed) => this.installedSkillEntry(installed))
      .filter(({ status }) => status === 'active');
  }

  listCapabilitySkills(): CapabilitySkill[] {
    return this.listInstalledSkills().map((installed) => this.installedSkillEntry(installed)).map((skill): CapabilitySkill => {
      const {
        input_requirements: _inputRequirements,
        report_template: _reportTemplate,
        ...capabilitySkill
      } = skill;
      const taskTypes = skill.task_types ?? [];
      const inputs = skill.inputs ?? [];
      const visualInputs = skill.visual_inputs ?? [];
      const multipleVisualInputs = skill.multiple_visual_inputs ?? [];
      const datasetInputs = skill.dataset_inputs ?? [];
      const documentInputs = skill.document_inputs ?? [];
      const outputs = skill.outputs ?? [];
      const requiredTools = skill.required_tools ?? [];
      const optionalTools = skill.optional_tools ?? [];
      if (skill.status !== 'active') {
        return {
          ...capabilitySkill,
          status: skill.status,
          task_types: Array.isArray(taskTypes) ? taskTypes : [],
          inputs: Array.isArray(inputs) ? inputs : [],
          visual_inputs: Array.isArray(visualInputs) ? visualInputs : [],
          multiple_visual_inputs: Array.isArray(multipleVisualInputs) ? multipleVisualInputs : [],
          dataset_inputs: Array.isArray(datasetInputs) ? datasetInputs : [],
          document_inputs: Array.isArray(documentInputs) ? documentInputs : [],
          outputs: Array.isArray(outputs) ? outputs : [],
          required_tools: Array.isArray(requiredTools) ? requiredTools : [],
          optional_tools: Array.isArray(optionalTools) ? optionalTools : [],
        };
      }

      const knowledgeBaseSkill = skill.entry !== undefined || skill.path?.startsWith('knowledge-base/') === true;
      const visualInputIssue = skillVisualInputIssue(skill);
      const datasetInputIssue = skillDatasetInputIssue(skill);
      const documentInputIssue = skillDocumentInputIssue(skill);
      const optionalToolIssue = skillOptionalToolIssue(skill);
      if (
        unknownSkillBindingFields(skill).length > 0
        || visualInputIssue !== null
        || datasetInputIssue !== null
        || documentInputIssue !== null
        || optionalToolIssue !== null
        || !Array.isArray(taskTypes)
        || !Array.isArray(inputs)
        || !Array.isArray(visualInputs)
        || !Array.isArray(outputs)
        || !Array.isArray(requiredTools)
        || !Array.isArray(optionalTools)
        || taskTypes.length === 0
        || (!knowledgeBaseSkill && (inputs.length === 0 || outputs.length === 0 || requiredTools.length === 0))
      ) {
        throw new Error(`active skill capability metadata invalid: ${skill.id}`);
      }
      return {
        ...capabilitySkill,
        status: 'active',
        task_types: taskTypes,
        inputs,
        visual_inputs: visualInputs,
        multiple_visual_inputs: multipleVisualInputs,
        dataset_inputs: datasetInputs,
        document_inputs: documentInputs,
        outputs,
        required_tools: requiredTools,
        optional_tools: optionalTools,
      };
    });
  }

  listActiveTools(): ToolRegistryEntry[] {
    return loadToolRegistry().tools.filter((t) => t.status === 'active');
  }

  getSkill(id: string): SkillCapability | null {
    return this.listActiveSkills().find((s) => s.id === id) ?? null;
  }

  getTool(id: string): ToolRegistryEntry | null {
    return this.listActiveTools().find((t) => t.id === id) ?? null;
  }

  getRegisteredTool(id: string): ToolRegistryEntry | null {
    return loadToolRegistry().tools.find((tool) => tool.id === id) ?? null;
  }

  loadSkillPackage(id: string): SkillPackageSnapshot {
    const installed = this.installedCatalog.get(id);
    if (!installed || installed.readiness !== 'ready') {
      throw new Error(`skill 未找到或非 active: ${id}`);
    }
    return installed.package;
  }

  // 第二层:读命中的原版 Skill Package；现有调用方仍取得 SKILL.md 正文。
  loadSkillBody(id: string): { body: string; hash: string; path: string } {
    const entry = this.getSkill(id);
    if (!entry) throw new Error(`skill 未找到或非 active: ${id}`);
    const packageSnapshot = this.loadSkillPackage(id);
    const entryFile = packageSnapshot.files.find(({ path }) => path === packageSnapshot.entryPath);
    if (!entryFile) throw new Error(`skill ${id} entry is missing from package snapshot`);
    return {
      body: readSkillPackageText(packageSnapshot, packageSnapshot.entryPath),
      hash: entryFile.contentHash,
      path: entry.entry ?? entry.path,
    };
  }

  loadNativeRunSpec(id: string, planningContext?: unknown): NativeSkillRunSpec {
    const entry = this.getSkill(id);
    if (!entry) throw new Error(`skill 未找到或非 active: ${id}`);
    const packageSnapshot = this.loadSkillPackage(id);
    const entryFile = packageSnapshot.files.find(({ path }) => path === packageSnapshot.entryPath);
    if (!entryFile) throw new Error(`skill ${id} entry is missing from package snapshot`);
    const body = readSkillPackageText(packageSnapshot, packageSnapshot.entryPath);
    const reportTemplateCandidates = packageSnapshot.explicitReferences.filter((path) => (
      /(?:report[-_ ]?template|skeleton|报告模板|输出模板|输出骨架|报告骨架)/iu.test(path)
    ));
    const selectedReportPaths = selectReportTemplatePaths(reportTemplateCandidates, planningContext);
    const selectedPaths = new Set([
      ...packageSnapshot.files
        .filter(({ path }) => (
          path !== packageSnapshot.entryPath
          && body.includes(path)
          && !reportTemplateCandidates.includes(path)
        ))
        .map(({ path }) => path),
      ...selectedReportPaths,
    ]);
    const selectedReferences = [
      ...packageSnapshot.files
        .filter(({ path }) => selectedPaths.has(path))
        .map((file) => ({
          source: 'skill_package' as const,
          sourceId: id,
          logicalPath: `skill://${id}/${file.path}`,
          path: file.path,
          contentHash: file.contentHash,
          content: readSkillPackageText(packageSnapshot, file.path),
          selectedBy: 'explicit_reference' as const,
        })),
      ...this.knowledgeMounts.resolveReferences(body),
    ];
    const fallbackRoles = [
      ...(entry.composition?.required_input_roles ?? entry.inputs ?? []),
      ...(entry.composition?.optional_input_roles ?? []),
    ];
    const requiredRoles = new Set(entry.composition?.required_input_roles ?? entry.inputs ?? []);
    const inputRequirements: SkillInputRequirement[] = entry.input_requirements
      ? parseSkillInputRequirements(entry.input_requirements)
      : [...new Set(fallbackRoles)].map((key) => {
          const kind = entry.dataset_inputs?.includes(key)
            ? 'dataset' as const
            : entry.document_inputs?.includes(key)
              ? 'document' as const
              : entry.visual_inputs?.includes(key) ? 'visual' as const : 'value' as const;
          const label = inputLabel(key);
          return {
            key,
            kind,
            label,
            description: `${label}，用于完成本次分析。`,
            required: requiredRoles.has(key),
            multiple: kind === 'document' || entry.multiple_visual_inputs?.includes(key) === true,
            acceptedSources: kind === 'value'
              ? ['conversation'] as const
              : ['upload'] as const,
            question: `请提供${label}。`,
          };
        });
    if (inputRequirements.length === 0) {
      inputRequirements.push({
        key: 'research_goal',
        kind: 'value',
        label: '研究目标',
        description: '本次 Skill 需要回答的目标、范围与决策问题。',
        required: true,
        multiple: false,
        acceptedSources: ['conversation'],
        question: '本次需要解决什么问题？',
      });
    }
    const requiredToolIds = new Set(entry.required_tools ?? []);
    const declaredToolIds = [...requiredToolIds, ...(entry.optional_tools ?? [])];
    const registeredTools = loadToolRegistry().tools;
    const registeredById = new Map(registeredTools.map((tool) => [tool.id, tool]));
    const toolBindings = referencedToolIds(
      [body, ...selectedReferences.map(({ content }) => content)].join('\n'),
      declaredToolIds,
      registeredTools,
    ).map((toolId) => ({
      capability: toolId,
      toolId,
      required: requiredToolIds.has(toolId),
      status: declaredToolIds.includes(toolId) && registeredById.get(toolId)?.status === 'active'
        ? 'bound' as const
        : 'needs_binding' as const,
    }));
    const reportTemplatePaths = selectedReferences
      .map(({ path }) => path)
      .filter((path) => reportTemplateCandidates.includes(path));
    const bodyDefinesOutput = /(?:^|\n)#{1,4}\s*(?:输出|产出|交付|报告)|报告(?:格式|结构|模板)|输出骨架/iu.test(body);
    const reportInstructions = (reportTemplatePaths.length > 0
      ? reportTemplatePaths.map((path) => {
          const content = selectedReferences.find((reference) => reference.path === path)?.content ?? '';
          return `--- ${path} ---\n${content}`;
        })
      : bodyDefinesOutput ? [body] : [])
      .filter(Boolean)
      .join('\n\n');
    const reportFormatText = contextText(planningContext);
    const selectedHtmlTemplate = reportTemplatePaths.some((path) => /\.html?$/iu.test(path));
    const outputInstructions = `${body}\n${reportInstructions}`;
    const instructionsRequireHtml = /(?:必须|仅限|only|required|must)[^\n]{0,40}\bhtml\b|\bhtml\b[^\n]{0,40}(?:必须|only|required|must)/iu.test(outputInstructions);
    const requestedHtml = /(?:\bhtml\b|HTML\s*报告|网页报告)/iu.test(reportFormatText)
      || selectedHtmlTemplate
      || instructionsRequireHtml;
    const reportPolicy = reportInstructions
      ? {
          kind: 'skill_defined' as const,
          outputFormat: requestedHtml ? 'html' as const : 'markdown' as const,
          instructions: reportInstructions,
          instructionsHash: digest(reportInstructions),
        }
      : {
          kind: 'default_llm' as const,
          outputFormat: 'markdown' as const,
          promptVersion: DEFAULT_REPORT_PROMPT_VERSION,
          promptHash: digest(DEFAULT_REPORT_PROMPT),
        };
    return {
      skill_id: id,
      body,
      body_hash: entryFile.contentHash,
      package_hash: packageSnapshot.packageHash,
      entry_path: packageSnapshot.entryPath,
      files: packageSnapshot.files.map(({ path, mediaType, byteSize, contentHash }) => ({
        path, mediaType, byteSize, contentHash,
      })),
      selected_references: selectedReferences,
      input_requirements: inputRequirements,
      input_requirements_hash: digest(JSON.stringify(inputRequirements)),
      tool_bindings: toolBindings,
      report_policy: reportPolicy,
    };
  }

  loadSkillExecution(_id: string): LoadedSkillExecutionContract | null {
    return null;
  }

  // 第三层:执行期加载 Skill 输入与统一输出信封；有领域 payload 时内联为同一有效合同。
  loadSkillSchemas(id: string): LoadedSkillSchemas {
    const entry = this.getSkill(id);
    if (!entry) throw new Error(`skill 未找到或非 active: ${id}`);
    if (!entry.output_schema) throw new Error(`active skill 缺 output_schema: ${id}`);
    const root = getConfigRoot();
    const envelope = JSON.parse(readFileSync(join(root, entry.output_schema), 'utf8')) as object;
    const payload = entry.payload_schema
      ? JSON.parse(readFileSync(join(root, entry.payload_schema), 'utf8')) as object
      : undefined;
    return {
      input: entry.input_schema ? JSON.parse(readFileSync(join(root, entry.input_schema), 'utf8')) : undefined,
      output: composeSkillOutputSchema(envelope, payload),
    };
  }
}
