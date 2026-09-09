import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import express, { type Express } from 'express';
import { Pool } from 'pg';
import { signToken } from '../apps/agent-api/src/auth.ts';
import {
  createControlTasksRouter,
  type ControlTasksRuntime,
} from '../apps/agent-api/src/routes/control-tasks.ts';
import { TaskWorkflowService } from '../apps/orchestrator-runtime/src/control/task-workflow.ts';
import type { CurrentPlanningResponse } from '../apps/agent-api/src/routes/control-planning.ts';
import { ControlArtifactStore } from '../apps/orchestrator-runtime/src/control/artifact-store.ts';
import { ReportPackageArtifactService } from '../apps/orchestrator-runtime/src/report/report-package-artifact.ts';
import type {
  CurrentResearchPlanningResult,
  ResearchPlanningInput,
} from '../apps/orchestrator-runtime/src/planners/research-planning-service.ts';
import type { CandidateProfile, ResearchTaskV2 } from '../packages/api-contract/plan.ts';
import {
  MockLLMClient,
  type LLMClient,
  type LLMProviderIdentity,
  type LLMResult,
  type StructuredLLMCallOptions,
  type TextLLMCallOptions,
  type TextLLMResult,
} from '../apps/orchestrator-runtime/src/runtime/llm-client.ts';
import { SkillLoader } from '../apps/orchestrator-runtime/src/runtime/skill-loader.ts';
import {
  ToolRouter,
  type ToolAdapter,
  type ToolInvokeResult,
} from '../apps/orchestrator-runtime/src/runtime/tool-adapter.ts';
import type { ToolManifest } from '../apps/orchestrator-runtime/src/runtime/config-loader.ts';
import { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';
import { ControlPlaneAuthorizationError, ControlPlaneRepository } from '../database/control-plane.ts';
import { writeMessage } from '../database/repository.ts';
import {
  runMigrations,
  type MigrationConnection,
  type MigrationDatabase,
} from '../database/migration-runner.ts';
import type {
  ControlExecutionResult,
  ControlPlanCandidatesResponse,
  ControlWorkflowState,
  CurrentTaskReadResponse,
  TaskFollowUpResponse,
} from '../packages/api-contract/control-workflow.ts';
import { HISTORICAL_FINAL_REPORT_VERSION } from '../packages/api-contract/historical-final-report.ts';

interface ConversationAdapter {
  create(input: { ownerUserId: string; title: string }): Promise<{ id: string }>;
  requireOwned(input: { conversationId: string; ownerUserId: string }): Promise<{ id: string }>;
  listMessages(input: {
    conversationId: string;
    ownerUserId: string;
  }): Promise<Array<{ role: string; content: string }>>;
  appendMessage(input: {
    conversationId: string;
    role: 'user' | 'assistant';
    content: string;
    idempotencyKey?: string;
  }): Promise<void>;
}

interface ControlRuntimeOverrides {
  repository: ControlPlaneRepository;
  conversations: ConversationAdapter;
  planning?: {
    plan(input: ResearchPlanningInput): Promise<CurrentResearchPlanningResult>;
  };
  tools: ToolRouter;
  llm: LLMClient;
  validator: SchemaValidator;
  skillLoader: SkillLoader;
  artifacts: ControlArtifactStore;
  expectedActualModel?: string;
  multiSkillPortfolioMode?: 'inactive' | 'active';
}

interface ControlRuntimeHarness {
  controlPlanning: {
    plan(input: {
      originalInput: string;
      conversationId?: string;
      ownerUserId: string;
    }): Promise<ControlPlanCandidatesResponse>;
  };
}

interface ControlRuntimeModule {
  buildControlRuntime(overrides: ControlRuntimeOverrides): ControlRuntimeHarness;
}

type PlannedCreateAgentApiApp = (dependencies: { controlRuntime: unknown }) => Express;
type ClosePool = () => Promise<void>;

type ExecutionResponse = ControlExecutionResult & {
  state: ControlWorkflowState;
  deliverableArtifactId: string;
  evidenceManifestArtifactId: string;
  reportReviewArtifactId: string;
  reportPackageArtifactId: string;
};

class ScopedIntegrationDatabase implements MigrationDatabase {
  constructor(
    private readonly database: Pool,
    private readonly schema: string,
  ) {}

  async connect(): Promise<MigrationConnection> {
    const client = await this.database.connect();
    await client.query(`SET search_path TO "${this.schema}", public`);
    return {
      async query(sql, values = []) {
        const result = await client.query(sql, [...values]);
        return { rows: result.rows };
      },
      release() {
        client.release();
      },
    };
  }
}

class OfflineRealTavilyAdapter implements ToolAdapter {
  readonly adapterType = 'tavily' as const;

  readonly implementationId = 'offline-real-tavily-fixture-v1';
  readonly executionMode = 'real' as const;
  calls = 0;

  endpointHost(): string {
    return 'tavily.fixture.test';
  }

  async invoke(options: {
    toolId: string;
    input: object;
    manifest: ToolManifest;
  }): Promise<ToolInvokeResult> {
    this.calls += 1;
    return {
      output: {
        answer: null,
        response_time: 0.01,
        results: [{
          title: '宠物辅食公开市场资料',
          url: evidenceUrl,
          snippet: '公开页面展示宠物辅食产品定位、适用场景与品牌信息。',
          score: 0.99,
          published_date: null,
        }],
      },
      latencyMs: 1,
      receipt: {
        declaredAdapterType: options.manifest.adapter_type,
        resolvedAdapterType: this.adapterType,
        implementationId: this.implementationId,
        executionMode: this.executionMode,
        endpointHost: this.endpointHost(),
        status: 'ok',
        latencyMs: 1,
      },
    };
  }
}

class OfflineEligibleRealLLM implements LLMClient {
  readonly identity: LLMProviderIdentity = {
    provider: 'offline-fixture',
    endpointHost: 'llm.fixture.test',
    requestedModel: 'fixture-real-model',
    mode: 'real',
    eligibleAsReal: true,
  };
  calls = 0;
  skillContexts: object[] = [];
  private reviewCall = 0;

  constructor(private readonly reviewVerdicts: readonly ('pass' | 'revise' | 'block')[] = ['pass']) {}

  async generateStructured<T>(options: StructuredLLMCallOptions): Promise<LLMResult<T>> {
    this.calls += 1;
    let data: unknown;
    if (options.schemaName.startsWith('skill:')) {
      this.skillContexts.push(structuredClone(options.context ?? {}));
      const properties = (options.schema as { properties?: Record<string, unknown> }).properties;
      data = properties?.primary
        ? {
            title: '宠物辅食竞品分析',
            status: 'completed',
            primary: {
              format: 'markdown',
              content: `# 宠物辅食竞品分析\n\n公开资料支持竞品场景定位差异 [S-step-1-1]。`,
            },
            attachments: [],
            gaps: [],
          }
        : {
            version: 'skill-output-v2',
            status: 'succeeded',
            summary: '基于公开来源完成宠物辅食竞品分析。',
            findings: [{ id: 'finding-1', statement: '公开资料支持竞品场景定位差异。', confidence: 0.9 }],
            assumptions: [],
            limitations: [],
            recommendations: ['按宠物类型与使用场景细分研究样本。'],
            payload: {
              comparison_matrix: [{
                competitor: '公开竞品 A',
                dimension: '产品定位',
                assessment: '公开来源支持其宠物辅食场景定位',
                source: 'tool_result',
              }],
              differentiation_opportunities: ['按宠物类型与使用场景细分研究样本'],
              sources: [evidenceUrl],
            },
          };
    } else if (options.schemaName === 'research-task-v2') {
      data = {
        version: 'research-task-v2',
        task_type: 'competitive_research',
        business_domain: '宠物辅食',
        research_goal: '形成基于公开证据的宠物辅食竞品研究计划',
        target_audience: ['宠物食品产品与市场团队'],
        scope: ['公开可访问的宠物辅食竞品资料'],
        constraints: [{
          id: 'public-evidence-only',
          statement: '仅使用公开可验证来源',
          source: 'user',
        }],
        success_criteria: [{
          id: 'verifiable-comparison',
          statement: '输出基于公开证据且可追溯的竞品研究计划',
        }],
        expected_deliverables: ['competitive_analysis_report'],
        assumptions: [],
        ambiguities: [],
        clarification_questions: [],
        blocking_issues: [],
        sensitivity: 'public',
        pii_detected: false,
      };
    } else if (options.schemaName === 'decision-states') {
      data = [];
    } else if (options.schemaName === 'problem-graph') {
      const graphContext = options.context as {
        task: ResearchTaskV2;
        evidencePolicy: Array<{
          id: string;
          acceptedClasses: Array<'public_source'>;
          minimumCount: number;
          required: boolean;
        }>;
      };
      data = {
        version: 'problem-graph-v1',
        questions: [{
          id: 'competitive-question',
          statement: '主要竞品的公开定位差异是什么？',
          rationale: '回答竞品研究目标',
          priority: 'required',
          success_criterion_ids: graphContext.task.success_criteria.map((criterion) => criterion.id),
          evidence_requirements: graphContext.evidencePolicy,
          acceptance_criteria: ['至少一个公开来源支撑结论'],
          depends_on: [],
        }],
      };
    } else if (options.schemaName === 'current-plan-candidates') {
      const proposalById = new Map(planningResult('offline-current-candidate').candidates.map((candidate) => {
        const { activated_nodes: _activatedNodes, ...proposal } = candidate;
        return [candidate.id, {
          ...proposal,
          steps: proposal.steps.map((step) => step.actor_type === 'skill'
            ? { ...step, actor_id: 'competitive-web-research' }
            : step),
        }];
      }));
      const profileSpecs = (options.context as {
        profile_specs?: Array<{ id: 'speed' | 'depth'; display_name?: string }>;
      }).profile_specs ?? [{ id: 'depth' as const }, { id: 'speed' as const }];
      data = {
        candidates: profileSpecs.map(({ id, display_name }) => {
          const proposal = proposalById.get(id);
          if (!proposal) throw new Error(`missing fixture candidate for ${id}`);
          return { ...proposal, title: display_name ?? proposal.title };
        }),
      };
    } else if (options.schemaName === 'research-plan-deliverable-content') {
      const deliverableContext = options.context as {
        verifiedEvidence?: Array<{ evidenceId?: unknown }>;
        coverageRequirements?: {
          requiredQuestionIds: string[];
          successCriterionIds: string[];
        };
      } | undefined;
      data = validDeliverableDraft(
        deliverableContext?.verifiedEvidence?.[0]?.evidenceId,
        deliverableContext?.coverageRequirements,
      );
    } else if (options.schemaName === 'reviewer-step-output') {
      data = {
        version: 'reviewer-step-output-v1',
        review: 'No conditions remain.',
        verdict: 'pass',
        conditions: [],
      };
    } else if (options.schemaName === 'report-review') {
      const verdict = this.reviewVerdicts[this.reviewCall]
        ?? this.reviewVerdicts[this.reviewVerdicts.length - 1]
        ?? 'pass';
      this.reviewCall += 1;
      data = {
        verdict,
        dimensions: [
          'requirement_coverage',
          'question_coverage',
          'evidence_coverage',
          'reasoning_quality',
          'recommendation_quality',
          'visual_quality',
          'risk_disclosure',
        ].map((id) => ({
          id,
          passed: verdict === 'pass' || id !== 'risk_disclosure',
          issues: verdict === 'pass' || id !== 'risk_disclosure' ? [] : [`${verdict} requires revision`],
        })),
      };
    } else {
      data = { ok: true };
    }
    return {
      data: data as T,
      promptHash: hashPrompt(options.prompt),
      modelName: this.identity.requestedModel,
      modelVersion: 'fixture-real-model-v1',
      traceId: `trace-structured-${this.calls}`,
      tokens: { prompt: 12, completion: 8, total: 20 },
    };
  }

  async generateText(options: TextLLMCallOptions): Promise<TextLLMResult> {
    this.calls += 1;
    return {
      text: `offline ${options.receipt.stage} result grounded in ${evidenceUrl}`,
      promptHash: hashPrompt(options.prompt),
      modelName: this.identity.requestedModel,
      modelVersion: 'fixture-real-model-v1',
      traceId: `trace-text-${this.calls}`,
      tokens: { prompt: 8, completion: 4, total: 12 },
    };
  }
}

class ClarificationRetryLLM implements LLMClient {
  readonly identity: LLMProviderIdentity = {
    provider: 'clarification-retry-fixture',
    endpointHost: 'clarification-retry.fixture.test',
    requestedModel: 'clarification-retry-model',
    mode: 'mock',
    eligibleAsReal: false,
  };
  requirementCalls = 0;

  async generateStructured<T>(options: StructuredLLMCallOptions): Promise<LLMResult<T>> {
    if (options.schemaName !== 'research-task-v2') throw new Error(`unexpected schema ${options.schemaName}`);
    this.requirementCalls += 1;
    const data = this.requirementCalls === 1
      ? clarificationRequirement()
      : resolvedClarificationRequirement();
    return {
      data: data as T,
      promptHash: hashPrompt(options.prompt),
      modelName: this.identity.requestedModel,
      modelVersion: 'fixture-v1',
      traceId: `trace-clarification-${this.requirementCalls}`,
    };
  }

  async generateText(): Promise<never> {
    throw new Error('not used');
  }
}

class PlanningModelFixtureLLM implements LLMClient {
  readonly identity: LLMProviderIdentity;
  private readonly fixtures: MockLLMClient;

  constructor(
    requestedModel: string,
    private readonly actualModel: string,
    private readonly requirement: ResearchTaskV2 = resolvedClarificationRequirement(),
  ) {
    this.identity = {
      provider: 'planning-model-fixture',
      endpointHost: 'planning-model.fixture.test',
      requestedModel,
      mode: 'mock',
      eligibleAsReal: false,
    };
    this.fixtures = new MockLLMClient();
  }

  async generateStructured<T>(options: StructuredLLMCallOptions): Promise<LLMResult<T>> {
    let data: unknown;
    if (options.schemaName === 'research-task-v2') {
      data = this.requirement;
    } else if (options.schemaName === 'decision-states') {
      data = [];
    } else if (options.schemaName === 'problem-graph') {
      const graphContext = options.context as {
        task: ResearchTaskV2;
        evidencePolicy: unknown[];
      };
      data = {
        version: 'problem-graph-v1',
        questions: [{
          id: 'model-receipt-question',
          statement: '如何生成可执行研究计划？',
          rationale: '覆盖成功标准',
          priority: 'required',
          success_criterion_ids: graphContext.task.success_criteria.map((criterion) => criterion.id),
          evidence_requirements: graphContext.evidencePolicy,
          acceptance_criteria: ['研究计划可执行'],
          depends_on: [],
        }],
      };
    } else if (options.schemaName === 'current-plan-candidates') {
      const systemStep = (actorType: 'llm' | 'reviewer', actorId: string, dependsOn: number[]) => ({
        step_no: 99,
        step_name: actorId,
        actor_type: actorType,
        actor_id: actorId,
        question_ids: ['model-receipt-question'],
        depends_on: dependsOn,
        input: {},
        input_bindings: [],
        expected_outputs: [{
          pointer: actorType === 'llm' ? '/text' : '/review',
          description: `${actorId} result`,
        }],
        acceptance_criteria: ['研究计划可执行'],
        requires_approval: false,
        fallback_actor_ids: [],
      });
      const skillStep = () => {
        const skillId = this.requirement.task_type === 'competitive_research'
          ? 'competitive-analysis'
          : 'generate-interview-guide';
        return {
          step_no: 99,
          step_name: skillId,
          actor_type: 'skill' as const,
          actor_id: skillId,
          question_ids: ['model-receipt-question'],
          depends_on: [],
          input: { research_goal: this.requirement.research_goal },
          input_bindings: [],
          expected_outputs: [{ pointer: '/payload', description: 'skill result' }],
          acceptance_criteria: ['研究计划可执行'],
          requires_approval: false,
          fallback_actor_ids: [],
        };
      };
      const specialtyCandidate = (
        id: Exclude<CandidateProfile, 'speed' | 'depth'>,
        title: string,
      ) => ({
        id,
        title,
        rationale: `按${title}组织研究路径`,
        tradeoffs: '针对性增强，需要对应能力可用',
        steps: [{
          ...skillStep(),
          input: { research_goal: this.requirement.research_goal, profile_contract: id },
        }],
        assumptions: [],
      });
      const candidateById = new Map<CandidateProfile, {
        id: CandidateProfile;
        title: string;
        rationale: string;
        tradeoffs: string;
        steps: Array<ReturnType<typeof systemStep> | ReturnType<typeof skillStep>>;
        assumptions: never[];
      }>([
        ['depth', {
          id: 'depth',
          title: '深度研究',
          rationale: '包含复核',
          tradeoffs: '耗时更长',
          steps: [
            skillStep(),
            systemStep('reviewer', 'evidence-reviewer', [1]),
          ],
          assumptions: [],
        }],
        ['speed', {
          id: 'speed',
          title: '快速研究',
          rationale: '最短路径',
          tradeoffs: '复核较少',
          steps: [skillStep()],
          assumptions: [],
        }],
        ['breadth', specialtyCandidate('breadth', '广度扫描')],
        ['focused', specialtyCandidate('focused', '聚焦关键链路')],
        ['mixed_method', specialtyCandidate('mixed_method', '混合方法')],
        ['decision', specialtyCandidate('decision', '决策收敛')],
        ['remediation', specialtyCandidate('remediation', '整改复测')],
      ]);
      const profileSpecs = (options.context as {
        profile_specs?: Array<{ id: CandidateProfile; display_name?: string }>;
      }).profile_specs ?? [{ id: 'depth' as const }, { id: 'speed' as const }];
      data = {
        candidates: profileSpecs.map(({ id, display_name }) => {
          const proposal = candidateById.get(id);
          if (!proposal) throw new Error(`missing fixture candidate for ${id}`);
          return { ...proposal, title: display_name ?? proposal.title };
        }),
      };
    } else {
      const generated = await this.fixtures.generateStructured<T>(options);
      return {
        ...generated,
        modelName: this.actualModel,
        modelVersion: `${this.actualModel}-fixture-v1`,
      };
    }
    return {
      data: data as T,
      promptHash: hashPrompt(options.prompt),
      modelName: this.actualModel,
      modelVersion: `${this.actualModel}-fixture-v1`,
      traceId: `trace-${options.schemaName}`,
    };
  }

  async generateText(options: TextLLMCallOptions): Promise<TextLLMResult> {
    const generated = await this.fixtures.generateText(options);
    return {
      ...generated,
      modelName: this.actualModel,
      modelVersion: `${this.actualModel}-fixture-v1`,
    };
  }
}

const originalJwtSecret = process.env.JWT_SECRET;
const originalPgOptions = process.env.PGOPTIONS;
const schema = `control_api_integration_${randomUUID().replaceAll('-', '')}`;
const artifactRoot = mkdtempSync(join(tmpdir(), 'control-api-integration-artifacts-'));
const database = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://localhost:5432/user_research_ai',
});
const scopedDatabase = new ScopedIntegrationDatabase(database, schema);
const repository = new ControlPlaneRepository(scopedDatabase);
const evidenceUrl = 'https://evidence.test/pet-supplement-market';
const runtimeModulePath: string = '../apps/agent-api/src/control-runtime.ts';
const runtimeModuleFile = new URL(runtimeModulePath, import.meta.url);

let ownerUserId = '';
let foreignUserId = '';
let conversationId = '';
let server: Server | undefined;
let closeSharedPool: ClosePool | undefined;

function hashPrompt(prompt: string): string {
  return `sha256:${createHash('sha256').update(prompt).digest('hex')}`;
}

function restoreEnvironment(name: 'JWT_SECRET' | 'PGOPTIONS', value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function validDeliverableDraft(
  evidenceId: unknown = 'missing-evidence',
  coverageRequirements: {
    requiredQuestionIds: string[];
    successCriterionIds: string[];
  } = {
    requiredQuestionIds: ['competitive-question'],
    successCriterionIds: ['verifiable-comparison'],
  },
): Record<string, unknown> {
  return {
    methodSummary: '使用离线真实模式适配器采集公开资料，并按冻结研究维度形成计划。',
    findingGraph: {
      findings: [{
        id: 'F1',
        kind: 'fact',
        evidenceIds: [String(evidenceId)],
        statement: '公开页面提供了可核验的宠物辅食产品与品牌信息。',
      }],
      analyses: [{
        id: 'A1',
        findingIds: ['F1'],
        statement: '公开事实足以支持研究样本与产品定位维度设计。',
      }],
      subQuestionSummaries: [{
        id: 'S1',
        findingIds: ['F1'],
        analysisIds: ['A1'],
        summary: '公开资料支持以产品定位作为首个比较维度。',
      }],
      overallConclusions: [{
        id: 'C1',
        summaryIds: ['S1'],
        statement: '研究计划应优先覆盖产品定位、适用宠物与使用场景。',
      }],
    },
    payload: {
      title: '宠物辅食竞品研究计划',
      researchGoal: '形成基于公开证据的宠物辅食竞品研究计划',
      scope: {
        market: '中国大陆宠物辅食市场',
        subjects: ['犬用辅食', '猫用辅食'],
        timeWindow: '最近十二个月',
      },
      competitorSampling: {
        strategy: '按公开市场影响力与产品覆盖分层抽样',
        targetCount: 6,
        inclusionCriteria: ['存在可核验的公开产品资料'],
        exclusionCriteria: ['无公开资料或已停止销售'],
      },
      researchQuestions: ['competitive-question', '主要竞品如何定位宠物类型与消费场景？'],
      comparisonDimensions: [{
        id: 'positioning',
        name: '产品定位',
        purpose: '比较目标宠物、消费场景与核心卖点',
        collectionFields: ['目标宠物', '消费场景', '核心卖点'],
      }],
      sourcePlan: [{
        evidenceClass: 'public_source',
        sourceTypes: ['品牌官网', '公开商品页'],
        purpose: '核验产品信息与品牌定位',
      }],
      executionPlan: [{
        phase: '公开资料采集',
        activities: ['检索并记录入样品牌公开资料'],
        duration: '2 个工作日',
        outputs: ['竞品信息采集表'],
      }],
      collectionTemplate: [{
        field: '核心卖点',
        description: '品牌对产品价值的公开表述',
        evidenceRequired: true,
      }],
      analysisMethods: ['横向维度对比'],
      deliverables: ['竞品研究计划'],
      qualityChecks: ['verifiable-comparison', '每项事实均关联可追溯公开来源'],
    },
    recommendations: [{
      id: 'R1',
      summaryIds: ['S1'],
      statement: '按产品定位维度继续采集公开信息。',
    }],
    coverage: {
      questionBindings: coverageRequirements.requiredQuestionIds.map((questionId) => ({
        questionId,
        summaryIds: ['S1'],
      })),
      successCriterionBindings: coverageRequirements.successCriterionIds.map((successCriterionId) => ({
        successCriterionId,
        conclusionIds: ['C1'],
        recommendationIds: ['R1'],
      })),
    },
    risksAndOpenIssues: [],
  };
}

function planningResult(
  originalInput: string,
  requirement?: ResearchTaskV2,
  requireBusinessDomainInput = false,
): CurrentResearchPlanningResult {
  const structuredTask: ResearchTaskV2 = requirement ?? {
    version: 'research-task-v2',
    task_type: 'user_research_planning',
    business_domain: '宠物辅食',
    research_goal: '形成基于公开证据的宠物辅食竞品研究计划',
    target_audience: ['宠物食品产品与市场团队'],
    scope: ['公开资料'],
    constraints: [],
    success_criteria: [{ id: 'verifiable-comparison', statement: '结论可追溯' }],
    expected_deliverables: ['research_plan'],
    assumptions: [],
    ambiguities: [],
    clarification_questions: [],
    blocking_issues: [],
    sensitivity: 'public',
    pii_detected: false,
  };
  const evidenceRequirements = structuredTask.task_type === 'competitive_research'
    ? [{
        id: 'competitive-analysis-report',
        acceptedClasses: ['public_source', 'screenshot'] as const,
        minimumCount: 1,
        required: true,
      }]
    : [{
        id: 'research-plan',
        acceptedClasses: ['user_input', 'knowledge', 'public_source'] as const,
        minimumCount: 1,
        required: true,
      }];
  const problemGraph = {
    version: 'problem-graph-v1' as const,
    questions: [{
      id: 'competitive-question',
      statement: '主要竞品的公开定位差异是什么？',
      rationale: '回答竞品研究目标',
      priority: 'required' as const,
      success_criterion_ids: [structuredTask.success_criteria[0]!.id],
      evidence_requirements: evidenceRequirements.map((item) => ({
        ...item,
        acceptedClasses: [...item.acceptedClasses],
      })),
      acceptance_criteria: ['至少一个公开来源支撑结论'],
      depends_on: [],
    }],
  };
  const capabilityResolution = {
    eligible: [{
      skill: {
        id: 'digital-human-competitive-analysis',
        name: '数字人竞品分析',
        path: 'skills/competitive-analysis/digital-human/SKILL.md',
        when_to_use: '竞品研究',
        owner: '竞品分析组',
        status: 'active' as const,
        task_types: ['competitive_research'],
        inputs: ['business_domain'],
        outputs: ['competitive_analysis'],
        required_tools: ['tavily-web-search'],
        optional_tools: [],
        risk_level: 'low' as const,
      },
      reasons: requireBusinessDomainInput
        ? [
            { code: 'pending_input_required' as const, message: 'business_domain must be supplied explicitly' },
            { code: 'eligible' as const, message: 'eligible' },
          ]
        : [{ code: 'eligible' as const, message: 'eligible' }],
      pending_inputs: requireBusinessDomainInput
        ? [{
            kind: 'value' as const,
            role: 'business_domain',
            label: '研究业务领域',
            multiple: false,
            capability_id: 'digital-human-competitive-analysis',
          }]
        : [],
      required_approvals: [],
      optional_tool_decisions: [],
    }],
    rejected: [],
  };
  const steps = (mode: 'depth' | 'speed') => [
    {
      step_no: 99,
      step_name: `${mode} 公开来源检索`,
      actor_type: 'tool' as const,
      actor_id: 'tavily-web-search',
      question_ids: ['competitive-question'],
      depends_on: [],
      input: {
        query: originalInput,
        max_results: 3,
        search_depth: mode === 'depth' ? 'advanced' : 'basic',
        include_answer: false,
      },
      input_bindings: [],
      expected_outputs: [{ pointer: '/results', description: '公开来源结果' }],
      acceptance_criteria: ['返回至少一个公开来源'],
      requires_approval: false,
      fallback_actor_ids: [],
    },
    {
      step_no: 99,
      step_name: `${mode} 竞品分析`,
      actor_type: 'skill' as const,
      actor_id: 'digital-human-competitive-analysis',
      question_ids: ['competitive-question'],
      depends_on: [1],
      input: { business_domain: structuredTask.business_domain },
      input_bindings: [],
      expected_outputs: [{ pointer: '/payload/comparison_matrix', description: '竞品对比矩阵' }],
      acceptance_criteria: ['分析引用公开来源'],
      requires_approval: false,
      fallback_actor_ids: [],
    },
    {
      step_no: 99,
      step_name: `${mode} 研究摘要`,
      actor_type: 'llm' as const,
      actor_id: 'research-synthesis',
      question_ids: ['competitive-question'],
      depends_on: [2],
      input: { comparison_matrix: null },
      input_bindings: [{ target_pointer: '/comparison_matrix', source_step_no: 2, source_pointer: '/payload/comparison_matrix' }],
      expected_outputs: [{ pointer: '/text', description: '研究摘要' }],
      acceptance_criteria: ['摘要覆盖研究问题'],
      requires_approval: false,
      fallback_actor_ids: [],
    },
    {
      step_no: 99,
      step_name: `${mode} 证据复核`,
      actor_type: 'reviewer' as const,
      actor_id: 'evidence-reviewer',
      question_ids: ['competitive-question'],
      depends_on: [3],
      input: { summary: null },
      input_bindings: [{ target_pointer: '/summary', source_step_no: 3, source_pointer: '/text' }],
      expected_outputs: [{ pointer: '/review', description: '证据复核' }],
      acceptance_criteria: ['所有结论可追溯'],
      requires_approval: false,
      fallback_actor_ids: [],
    },
  ];
  const candidate = (id: 'depth' | 'speed') => ({
    id,
    recommended: id === 'depth',
    title: id === 'depth' ? '深度研究' : '快速研究',
    rationale: id === 'depth' ? '优先覆盖更多研究维度' : '优先形成可信的最小闭环',
    tradeoffs: id === 'depth' ? '执行时间更长' : '研究维度更聚焦',
    steps: steps(id),
    assumptions: [],
    activated_nodes: ['D5_competitive', 'D6_evidence'],
  });
  return {
    task: {
      task_type: structuredTask.task_type,
      business_domain: structuredTask.business_domain,
      research_goal: structuredTask.research_goal,
      assumptions: [],
      confirmations: [],
      blocking_issues: [],
      sensitivity: 'public',
      pii_detected: false,
    },
    structuredTask,
    activatedNodes: ['D5_competitive', 'D6_evidence'],
    decisionStates: [],
    candidates: [candidate('depth'), candidate('speed')],
    guidanceSources: [],
    provenance: {
      modelName: 'planner',
      modelVersion: '1',
      promptHash: originalInput,
      traceId: 'trace-planner',
    },
    problemGraph,
    problemGraphProvenance: {
      receiptId: '33333333-3333-4333-8333-333333333333',
      modelName: 'planner',
      modelVersion: '1',
      promptHash: 'sha256:problem-graph',
      traceId: 'trace-problem-graph',
    },
    capabilityResolution,
    planningProvenance: {
      version: 'planning-guidance-provenance-v1',
      resolver_version: 'candidate-profile-resolver-v1',
      scenario_catalog_hash: `sha256:${'1'.repeat(64)}`,
      signal_catalog_hash: `sha256:${'2'.repeat(64)}`,
      profile_spec_hash: `sha256:${'3'.repeat(64)}`,
      scenario_mapping_hash: `sha256:${'4'.repeat(64)}`,
      classification_method: 'fixed_policy',
      classifier_call_count: 0,
      primary_scenario_id: null,
      secondary_scenario_ids: [],
      confidence: null,
      signals: [],
      selected_profile_ids: ['depth', 'speed'],
      degradations: [{ code: 'dynamic_generation_disabled' }],
    },
  };
}

function conversationAdapter(): ConversationAdapter {
  return {
    async create(input) {
      const connection = await scopedDatabase.connect();
      try {
        const result = await connection.query(
          `INSERT INTO conversations (owner_user_id, title)
           VALUES ($1, $2) RETURNING id`,
          [input.ownerUserId, input.title],
        );
        return { id: String(result.rows[0]?.id) };
      } finally {
        connection.release();
      }
    },
    async requireOwned(input) {
      const connection = await scopedDatabase.connect();
      try {
        const result = await connection.query(
          `SELECT id FROM conversations WHERE id = $1 AND owner_user_id = $2`,
          [input.conversationId, input.ownerUserId],
        );
        const id = result.rows[0]?.id;
        if (typeof id !== 'string') {
          throw new ControlPlaneAuthorizationError('conversation is not owned by requester');
        }
        return { id };
      } finally {
        connection.release();
      }
    },
    async listMessages(input) {
      const connection = await scopedDatabase.connect();
      try {
        const result = await connection.query(
          `SELECT message.sender_type, message.content
           FROM messages AS message
           JOIN conversations AS conversation ON conversation.id = message.conversation_id
           WHERE message.conversation_id = $1 AND conversation.owner_user_id = $2
           ORDER BY message.created_at ASC`,
          [input.conversationId, input.ownerUserId],
        );
        return result.rows.map((row) => ({
          role: String(row.sender_type),
          content: typeof row.content === 'string' ? row.content : JSON.stringify(row.content),
        }));
      } finally {
        connection.release();
      }
    },
    async appendMessage(input) {
      const connection = await scopedDatabase.connect();
      try {
        await connection.query(
          `INSERT INTO messages
             (conversation_id, sender_type, message_type, content, idempotency_key)
           VALUES ($1, $2, 'text', $3, $4)
           ON CONFLICT (conversation_id, idempotency_key)
             WHERE idempotency_key IS NOT NULL
           DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key`,
          [input.conversationId, input.role, JSON.stringify(input.content), input.idempotencyKey ?? null],
        );
      } finally {
        connection.release();
      }
    },
  };
}

async function loadControlRuntimeModule(): Promise<ControlRuntimeModule> {
  assert.equal(
    existsSync(runtimeModuleFile),
    true,
    'production control runtime composition module must exist',
  );
  // The planned production module is absent in this RED. Keep the path dynamic so
  // the explicit existence assertion, rather than the module loader, states the gap.
  const moduleExports = await import(runtimeModulePath) as unknown as Record<string, unknown>;
  assert.equal(typeof moduleExports.buildControlRuntime, 'function');
  return moduleExports as unknown as ControlRuntimeModule;
}

async function closeServer(): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => {
    server?.close((error) => error ? reject(error) : resolve());
  });
}

async function postJson(
  baseUrl: string,
  path: string,
  token: string,
  body: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  });
}

function parseSseEvents(body: string): Array<{ event: string; data: unknown }> {
  return body.trim().split('\n\n').map((block) => {
    const lines = block.split('\n');
    const event = lines.find((line) => line.startsWith('event: '))?.slice('event: '.length) ?? '';
    const data = lines.find((line) => line.startsWith('data: '))?.slice('data: '.length) ?? 'null';
    return { event, data: JSON.parse(data) as unknown };
  });
}

async function listenLocalApp(app: Express): Promise<{ server: Server; baseUrl: string }> {
  const localServer = createServer(app);
  localServer.listen(0, '127.0.0.1');
  await once(localServer, 'listening');
  const address = localServer.address();
  assert.ok(address && typeof address !== 'string');
  return { server: localServer, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function closeLocalServer(localServer: Server): Promise<void> {
  const closed = once(localServer, 'close');
  localServer.close();
  await closed;
}

function clarificationRequirement(): ResearchTaskV2 {
  return {
    version: 'research-task-v2',
    task_type: 'competitive_research',
    business_domain: '宠物辅食',
    research_goal: '确认目标受众后生成竞品研究计划',
    target_audience: [],
    scope: ['公开资料'],
    constraints: [],
    success_criteria: [{ id: 'audience-confirmed', statement: '确认目标受众后生成可执行研究计划' }],
    expected_deliverables: ['competitive_analysis_report'],
    assumptions: [{ key: 'scope', value: '公开资料', editable: true }],
    ambiguities: [{ id: 'audience', statement: '目标受众未确定', blocking: true }],
    clarification_questions: [{ key: 'audience', question: '目标受众是谁？', rationale: '决定研究方法' }],
    blocking_issues: [],
    sensitivity: 'public',
    pii_detected: false,
  };
}

function resolvedClarificationRequirement(): ResearchTaskV2 {
  return {
    ...clarificationRequirement(),
    target_audience: ['产品团队'],
    ambiguities: [],
    clarification_questions: [],
  };
}

function scenarioSelectionRequirement(): ResearchTaskV2 {
  return {
    version: 'research-task-v2',
    task_type: 'user_research_planning',
    business_domain: '宠物心智设计表达',
    research_goal: '形成宠物心智的设计表达策略全景',
    target_audience: ['品牌与设计团队'],
    scope: ['全链路业务品牌心智', '品类特色心智', '场域心智策略'],
    constraints: [],
    success_criteria: [{ id: 'strategy-landscape', statement: '形成可用于后续研究决策的完整视图' }],
    expected_deliverables: ['research_plan'],
    assumptions: [],
    ambiguities: [],
    clarification_questions: [],
    blocking_issues: [],
    sensitivity: 'public',
    pii_detected: false,
  };
}

function controlTasksApp(runtime: ControlTasksRuntime): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/control-tasks', createControlTasksRouter(runtime));
  return app;
}

function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
}

before(async () => {
  await database.query(`CREATE SCHEMA "${schema}"`);
  await runMigrations({
    database: scopedDatabase,
    migrationsDir: join(process.cwd(), 'database', 'migrations'),
    lockKey: 761_831_015,
  });
  process.env.PGOPTIONS = `-c search_path=${schema},public`;
  process.env.JWT_SECRET = `control-api-integration-${randomUUID()}`;

  const connection = await scopedDatabase.connect();
  try {
    const ownerEmail = `owner-${randomUUID()}@test.local`;
    const foreignEmail = `foreign-${randomUUID()}@test.local`;
    const users = await connection.query(
      `INSERT INTO users (email, display_name, password_hash, role, status)
       VALUES
         ($1, 'control api owner', 'x', 'member', 'active'),
         ($2, 'control api foreign user', 'x', 'member', 'active')
       RETURNING id, email`,
      [ownerEmail, foreignEmail],
    );
    const userIds = new Map(users.rows.map((row) => [String(row.email), String(row.id)]));
    ownerUserId = userIds.get(ownerEmail) ?? '';
    foreignUserId = userIds.get(foreignEmail) ?? '';
    assert.ok(ownerUserId);
    assert.ok(foreignUserId);
    const conversation = await connection.query(
      `INSERT INTO conversations (owner_user_id, title)
       VALUES ($1, 'offline Current integration') RETURNING id`,
      [ownerUserId],
    );
    conversationId = String(conversation.rows[0]?.id);
    await connection.query(
      `INSERT INTO control_model_calls
         (id, stage, attempt_id, step_no, provider, endpoint_host, requested_model, actual_model, model_version,
          prompt_hash, context_manifest_hash, trace_id, status, started_at, finished_at)
       VALUES ('33333333-3333-4333-8333-333333333333', 'problem_graph', NULL, NULL, 'fixture', 'fixture.test',
               'planner', 'planner', '1', 'sha256:problem-graph',
               NULL, 'trace-problem-graph', 'succeeded', now(), now())`,
    );
  } finally {
    connection.release();
  }
});

after(async () => {
  const errors: unknown[] = [];
  try {
    await closeServer();
  } catch (error) {
    errors.push(error);
  }
  try {
    await closeSharedPool?.();
  } catch (error) {
    errors.push(error);
  }
  try {
    await database.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } catch (error) {
    errors.push(error);
  }
  try {
    await database.end();
  } catch (error) {
    errors.push(error);
  }
  rmSync(artifactRoot, { recursive: true, force: true });
  restoreEnvironment('JWT_SECRET', originalJwtSecret);
  restoreEnvironment('PGOPTIONS', originalPgOptions);
  if (errors.length) throw new AggregateError(errors, 'control API integration cleanup failed');
});

test('Dataset multipart upload forwards the owner-bound Idempotency-Key and parsed CSV metadata', async () => {
  const task = await repository.createTask({
    conversationId,
    ownerUserId,
    originalInput: 'dataset route',
    taskType: 'industry_market_analysis',
    structuredTask: { research_goal: '验证 Dataset 上传路由' },
    state: 'awaiting_confirmation',
  });
  const plan = await repository.createPlanVersion({
    taskId: task.id,
    version: 1,
    plan: { steps: [] },
    planHash: 'sha256:dataset-route-plan',
    pendingInputs: [],
  });
  const calls: unknown[] = [];
  const runtime = {
    repository,
    workflow: {} as TaskWorkflowService,
    getDeliverable: async () => null,
    uploadDataset: async (input: unknown) => {
      calls.push(input);
      return {
        datasetInputId: 'dataset-1', fileName: 'users.csv', contentSha256: `sha256:${'1'.repeat(64)}`,
        byteSize: 26, rowCount: 1, columns: ['sample_id', 'quote'],
      };
    },
  } as unknown as ControlTasksRuntime;
  const local = await listenLocalApp(controlTasksApp(runtime));
  const token = signToken({ userId: ownerUserId, email: 'owner@test.local' });
  const key = randomUUID();
  try {
    const form = new FormData();
    form.append('metadata', JSON.stringify({
      rowMeaning: '一行一位匿名用户', timeRange: '2026-Q3', fieldNotes: {}, units: {},
      sampling: '访谈样本', piiConfirmedAbsent: true,
    }));
    form.append('file', new Blob(['sample_id,quote\nu1,很好\n'], { type: 'text/csv' }), 'users.csv');
    const response = await fetch(
      `${local.baseUrl}/api/control-tasks/${task.id}/plans/${plan.id}/inputs/user_research_dataset/dataset`,
      { method: 'POST', headers: { authorization: `Bearer ${token}`, 'Idempotency-Key': key }, body: form },
    );
    assert.equal(response.status, 201, await response.clone().text());
    assert.equal(response.headers.get('Idempotency-Key'), key);
    assert.equal(calls.length, 1);
    const call = calls[0] as {
      taskId: string; planVersionId: string; role: string; ownerUserId: string;
      idempotencyKey: string; fileName: string; mediaType: string; bytes: Uint8Array;
    };
    assert.deepEqual({
      taskId: call.taskId, planVersionId: call.planVersionId, role: call.role,
      ownerUserId: call.ownerUserId, idempotencyKey: call.idempotencyKey,
      fileName: call.fileName, mediaType: call.mediaType, content: Buffer.from(call.bytes).toString('utf8'),
    }, {
      taskId: task.id, planVersionId: plan.id, role: 'user_research_dataset',
      ownerUserId, idempotencyKey: key, fileName: 'users.csv', mediaType: 'text/csv',
      content: 'sample_id,quote\nu1,很好\n',
    });
  } finally {
    await closeLocalServer(local.server);
  }
});

test('Document multipart upload forwards all selected files without inline Base64', async () => {
  const task = await repository.createTask({
    conversationId,
    ownerUserId,
    originalInput: 'document route',
    taskType: 'industry_market_analysis',
    structuredTask: { research_goal: '验证文档上传路由' },
    state: 'awaiting_confirmation',
  });
  const plan = await repository.createPlanVersion({
    taskId: task.id,
    version: 1,
    plan: { steps: [] },
    planHash: 'sha256:document-route-plan',
    pendingInputs: [],
  });
  const calls: unknown[] = [];
  const runtime = {
    repository,
    workflow: {} as TaskWorkflowService,
    getDeliverable: async () => null,
    uploadDocument: async (input: unknown) => {
      calls.push(input);
      return {
        documentInputId: 'document-1',
        files: [{
          fileName: 'background.md', mediaType: 'text/markdown; charset=utf-8',
          contentSha256: `sha256:${'2'.repeat(64)}`, byteSize: 8,
        }],
      };
    },
  } as unknown as ControlTasksRuntime;
  const local = await listenLocalApp(controlTasksApp(runtime));
  const token = signToken({ userId: ownerUserId, email: 'owner@test.local' });
  const key = randomUUID();
  try {
    const form = new FormData();
    form.append('file', new Blob(['# 业务背景'], { type: 'text/markdown' }), 'background.md');
    form.append('file', new Blob(['访谈内容'], { type: 'text/plain' }), 'interview.txt');
    const response = await fetch(
      `${local.baseUrl}/api/control-tasks/${task.id}/plans/${plan.id}/inputs/internal_documents/document`,
      { method: 'POST', headers: { authorization: `Bearer ${token}`, 'Idempotency-Key': key }, body: form },
    );
    assert.equal(response.status, 201, await response.clone().text());
    assert.equal(response.headers.get('Idempotency-Key'), key);
    assert.equal(calls.length, 1);
    const call = calls[0] as {
      taskId: string; planVersionId: string; role: string; ownerUserId: string;
      idempotencyKey: string; files: Array<{ fileName: string; mediaType: string; bytes: Uint8Array }>;
    };
    assert.deepEqual({
      taskId: call.taskId,
      planVersionId: call.planVersionId,
      role: call.role,
      ownerUserId: call.ownerUserId,
      idempotencyKey: call.idempotencyKey,
      files: call.files.map((file) => ({
        fileName: file.fileName,
        mediaType: file.mediaType,
        content: Buffer.from(file.bytes).toString('utf8'),
      })),
    }, {
      taskId: task.id,
      planVersionId: plan.id,
      role: 'internal_documents',
      ownerUserId,
      idempotencyKey: key,
      files: [{ fileName: 'background.md', mediaType: 'text/markdown', content: '# 业务背景' },
        { fileName: 'interview.txt', mediaType: 'text/plain', content: '访谈内容' }],
    });
  } finally {
    await closeLocalServer(local.server);
  }
});

test('Visual multipart upload forwards image bytes without data URLs', async () => {
  const task = await repository.createTask({
    conversationId,
    ownerUserId,
    originalInput: 'visual route',
    taskType: 'design_audit',
    structuredTask: { research_goal: '验证图片上传路由' },
    state: 'awaiting_confirmation',
  });
  const plan = await repository.createPlanVersion({
    taskId: task.id,
    version: 1,
    plan: { steps: [] },
    planHash: 'sha256:visual-route-plan',
    pendingInputs: [],
  });
  const calls: unknown[] = [];
  const runtime = {
    repository,
    workflow: {} as TaskWorkflowService,
    getDeliverable: async () => null,
    uploadVisual: async (input: unknown) => {
      calls.push(input);
      return {
        visualInputId: 'visual-1',
        images: [{ contentSha256: `sha256:${'3'.repeat(64)}`, mediaType: 'image/png', byteSize: 4 }],
      };
    },
  } as unknown as ControlTasksRuntime;
  const local = await listenLocalApp(controlTasksApp(runtime));
  const token = signToken({ userId: ownerUserId, email: 'owner@test.local' });
  const key = randomUUID();
  try {
    const form = new FormData();
    form.append('file', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), 'screen.png');
    const response = await fetch(
      `${local.baseUrl}/api/control-tasks/${task.id}/plans/${plan.id}/inputs/jd_screenshots/visual`,
      { method: 'POST', headers: { authorization: `Bearer ${token}`, 'Idempotency-Key': key }, body: form },
    );
    assert.equal(response.status, 201, await response.clone().text());
    assert.equal(calls.length, 1);
    const call = calls[0] as { files: Array<{ fileName: string; mediaType: string; bytes: Uint8Array }> };
    assert.deepEqual(call.files.map((file) => ({
      fileName: file.fileName,
      mediaType: file.mediaType,
      bytes: [...file.bytes],
    })), [{ fileName: 'screen.png', mediaType: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] }]);
    assert.doesNotMatch(JSON.stringify(call), /data:image|base64/u);

    const tooMany = new FormData();
    for (let index = 0; index < 13; index += 1) {
      tooMany.append(
        'file',
        new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }),
        `screen-${index + 1}.png`,
      );
    }
    const rejected = await fetch(
      `${local.baseUrl}/api/control-tasks/${task.id}/plans/${plan.id}/inputs/jd_screenshots/visual`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'Idempotency-Key': randomUUID() },
        body: tooMany,
      },
    );
    assert.equal(rejected.status, 422);
    assert.equal(calls.length, 1);
  } finally {
    await closeLocalServer(local.server);
  }
});

test('owner can download a generated native report ZIP', async () => {
  const task = await repository.createTask({
    conversationId,
    ownerUserId,
    originalInput: 'zip route',
    taskType: 'industry_market_analysis',
    structuredTask: { research_goal: '验证离线报告下载' },
    state: 'completed',
  });
  const runtime = {
    repository,
    workflow: {} as TaskWorkflowService,
    getDeliverable: async () => null,
    readFinalReportZip: async () => new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
  } as unknown as ControlTasksRuntime;
  const local = await listenLocalApp(controlTasksApp(runtime));
  try {
    const response = await fetch(`${local.baseUrl}/api/control-tasks/${task.id}/final-report.zip`, {
      headers: { authorization: `Bearer ${signToken({ userId: ownerUserId, email: 'owner@test.local' })}` },
    });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get('content-type'), 'application/zip');
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [0x50, 0x4b, 0x03, 0x04]);
  } finally {
    await closeLocalServer(local.server);
  }
});

test('production runtime serves a sealed historical Lightweight report read-only', async () => {
  const { buildControlRuntime } = await loadControlRuntimeModule();
  const task = await repository.createTask({
    conversationId,
    ownerUserId,
    originalInput: 'historical report route',
    taskType: 'research_synthesis',
    structuredTask: { research_goal: '读取历史报告' },
    state: 'completed_with_gaps',
    orchestrationMode: 'single_skill',
  });
  const historicalPlan = {
    task_id: task.id,
    execution_contract_version: 'lightweight-execution-plan-v1',
    mode: 'single_skill',
    steps: [],
  };
  const plan = await repository.createPlanVersion({
    taskId: task.id,
    version: 1,
    candidateId: 'speed',
    plan: historicalPlan,
    planHash: `sha256:${createHash('sha256').update(JSON.stringify(historicalPlan)).digest('hex')}`,
    pendingInputs: [],
  });
  const attemptId = randomUUID();
  const connection = await scopedDatabase.connect();
  try {
    await connection.query(
      `INSERT INTO control_execution_attempts
         (id, task_id, plan_version_id, attempt_no, state, started_at, finished_at)
       VALUES ($1, $2, $3, 1, 'completed', now(), now())`,
      [attemptId, task.id, plan.id],
    );
    await connection.query(
      `UPDATE control_tasks
       SET active_plan_version_id = $2, current_attempt_id = $3, updated_at = now()
       WHERE id = $1`,
      [task.id, plan.id, attemptId],
    );
  } finally {
    connection.release();
  }

  const report = {
    version: HISTORICAL_FINAL_REPORT_VERSION,
    taskId: task.id,
    planVersionId: plan.id,
    attemptId,
    mode: 'single_skill' as const,
    title: '历史研究报告',
    markdown: '# 历史研究报告\n\n保留来源 [S-1]。',
    sources: [{ id: 'S-1', title: '历史来源', type: 'tool_result' as const, url: evidenceUrl }],
    gaps: ['缺少历史截图'],
    skillReports: [{
      skillId: 'competitive-web-research',
      invocationId: 'invocation:competitive-web-research',
      status: 'completed_with_gaps' as const,
      path: 'skill-results/invocation%3Acompetitive-web-research.json',
    }],
  };
  const reportJson = `${JSON.stringify(report, null, 2)}\n`;
  const reportHtml = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body><h1>历史研究报告</h1></body></html>';
  const reportDirectory = join(artifactRoot, 'tasks', task.id, 'attempts', attemptId, 'reports');
  mkdirSync(reportDirectory, { recursive: true });
  const reportJsonPath = join(reportDirectory, 'final-report.json');
  const reportHtmlPath = join(reportDirectory, 'report.html');
  writeFileSync(reportJsonPath, reportJson);
  writeFileSync(reportHtmlPath, reportHtml);
  const historicalArtifacts = [
    {
      id: randomUUID(),
      kind: 'final_report',
      path: reportJsonPath,
      bytes: Buffer.from(reportJson),
    },
    {
      id: randomUUID(),
      kind: 'final_report_html',
      path: reportHtmlPath,
      bytes: Buffer.from(reportHtml),
    },
  ];
  const artifactConnection = await scopedDatabase.connect();
  try {
    for (const artifact of historicalArtifacts) {
      await artifactConnection.query(
        `INSERT INTO control_artifacts
           (id, task_id, plan_version_id, attempt_id, kind, contract_version,
            schema_version, state, storage_uri, content_sha256, byte_size, media_type,
            sensitivity, redaction_policy_version, redaction_status, sealed_at)
         VALUES ($1, $2, $3, $4, $5, 'trusted-p0-v1', $6, 'SEALED', $7, $8, $9, $10,
                 'internal', 'v1', 'sealed', now())`,
        [
          artifact.id,
          task.id,
          plan.id,
          attemptId,
          artifact.kind,
          HISTORICAL_FINAL_REPORT_VERSION,
          artifact.path,
          `sha256:${createHash('sha256').update(artifact.bytes).digest('hex')}`,
          artifact.bytes.byteLength,
          artifact.kind === 'final_report_html' ? 'text/html; charset=utf-8' : 'application/json',
        ],
      );
    }
  } finally {
    artifactConnection.release();
  }

  const artifacts = new ControlArtifactStore({ root: artifactRoot, registry: repository });

  const runtime = buildControlRuntime({
    repository,
    conversations: conversationAdapter(),
    tools: new ToolRouter(),
    llm: new OfflineEligibleRealLLM(),
    validator: new SchemaValidator(),
    skillLoader: new SkillLoader(),
    artifacts,
  }) as unknown as ControlTasksRuntime;
  const directReport = await runtime.getFinalReport?.(task.id, ownerUserId);
  assert.equal(directReport?.report.version, HISTORICAL_FINAL_REPORT_VERSION);
  const directHtml = await runtime.readFinalReportHtml?.({
    taskId: task.id,
    attemptId,
    ownerUserId,
  });
  assert.match(directHtml ?? '', /历史研究报告/u);
  const local = await listenLocalApp(controlTasksApp(runtime));
  const ownerToken = signToken({ userId: ownerUserId, email: 'owner@test.local' });
  const foreignToken = signToken({ userId: foreignUserId, email: 'foreign@test.local' });
  try {
    const finalResponse = await fetch(`${local.baseUrl}/api/control-tasks/${task.id}/final-report`, {
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(finalResponse.status, 200, await finalResponse.clone().text());
    assert.deepEqual(await finalResponse.json(), report);

    const htmlResponse = await fetch(`${local.baseUrl}/api/control-tasks/${task.id}/final-report.html`, {
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(htmlResponse.status, 200, await htmlResponse.clone().text());
    assert.match(await htmlResponse.text(), /历史研究报告/u);

    const resultsResponse = await fetch(`${local.baseUrl}/api/control-tasks/${task.id}/skill-results`, {
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(resultsResponse.status, 200, await resultsResponse.clone().text());
    assert.deepEqual(await resultsResponse.json(), { results: [] });

    const foreignResponse = await fetch(`${local.baseUrl}/api/control-tasks/${task.id}/final-report`, {
      headers: { authorization: `Bearer ${foreignToken}` },
    });
    assert.equal(foreignResponse.status, 404);

    writeFileSync(reportHtmlPath, `${reportHtml}\n<!-- tampered -->`);
    const tamperedResponse = await fetch(`${local.baseUrl}/api/control-tasks/${task.id}/final-report.html`, {
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(tamperedResponse.status, 500);
    writeFileSync(reportHtmlPath, reportHtml);

    assert.equal((await repository.listAttempts(task.id)).length, 1);
  } finally {
    await closeLocalServer(local.server);
  }
});

test('owner can read a sealed uploaded image through the report Asset route', async () => {
  const task = await repository.createTask({
    conversationId,
    ownerUserId,
    originalInput: 'uploaded image route',
    taskType: 'industry_market_analysis',
    structuredTask: { research_goal: '验证报告图片读取' },
    state: 'completed',
  });
  const runtime = {
    repository,
    workflow: {} as TaskWorkflowService,
    getDeliverable: async () => null,
    readVisualAsset: async () => ({
      artifact: { id: 'input-image-1' },
      bytes: new Uint8Array([1, 2, 3]),
      mediaType: 'image/png' as const,
      inputAsset: true as const,
    }),
  } as unknown as ControlTasksRuntime;
  const local = await listenLocalApp(controlTasksApp(runtime));
  try {
    const response = await fetch(`${local.baseUrl}/api/control-tasks/${task.id}/assets/input-image-1`, {
      headers: { authorization: `Bearer ${signToken({ userId: ownerUserId, email: 'owner@test.local' })}` },
    });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3]);
  } finally {
    await closeLocalServer(local.server);
  }
});

test('GET /api/control-tasks lists only tasks owned by the authenticated user', async () => {
  const ownerTask = await repository.createTask({
    conversationId,
    ownerUserId,
    originalInput: `owner-history-${randomUUID()}`,
    taskType: 'competitive_research',
    structuredTask: { task_type: 'competitive_research' },
    state: 'completed',
  });
  const connection = await scopedDatabase.connect();
  let foreignConversationId = '';
  try {
    const result = await connection.query(
      `INSERT INTO conversations (owner_user_id, title) VALUES ($1, 'foreign history') RETURNING id`,
      [foreignUserId],
    );
    foreignConversationId = String(result.rows[0]?.id);
  } finally {
    connection.release();
  }
  const foreignTask = await repository.createTask({
    conversationId: foreignConversationId,
    ownerUserId: foreignUserId,
    originalInput: `foreign-history-${randomUUID()}`,
    taskType: 'design_audit',
    structuredTask: { task_type: 'design_audit' },
    state: 'completed',
  });
  const app = controlTasksApp({
    repository,
    workflow: new TaskWorkflowService(repository),
    getDeliverable: async () => null,
  });
  const local = await listenLocalApp(app);
  try {
    const unauthorized = await fetch(`${local.baseUrl}/api/control-tasks`);
    assert.equal(unauthorized.status, 401);

    const ownerResponse = await fetch(`${local.baseUrl}/api/control-tasks`, {
      headers: { authorization: `Bearer ${signToken({ userId: ownerUserId, email: 'owner@test.local' })}` },
    });
    assert.equal(ownerResponse.status, 200, await ownerResponse.clone().text());
    const ownerBody = await ownerResponse.json() as {
      kind: string;
      tasks: Array<{ id: string; originalInput: string; taskType: string | null; state: string; createdAt: string; updatedAt: string }>;
    };
    assert.equal(ownerBody.kind, 'current');
    assert.ok(ownerBody.tasks.some((task) => task.id === ownerTask.id));
    assert.equal(ownerBody.tasks.some((task) => task.id === foreignTask.id), false);
    assert.ok(ownerBody.tasks.every((task) => task.originalInput && task.state && task.createdAt && task.updatedAt));

    const foreignResponse = await fetch(`${local.baseUrl}/api/control-tasks`, {
      headers: { authorization: `Bearer ${signToken({ userId: foreignUserId, email: 'foreign@test.local' })}` },
    });
    assert.equal(foreignResponse.status, 200, await foreignResponse.clone().text());
    const foreignBody = await foreignResponse.json() as { tasks: Array<{ id: string }> };
    assert.ok(foreignBody.tasks.some((task) => task.id === foreignTask.id));
    assert.equal(foreignBody.tasks.some((task) => task.id === ownerTask.id), false);
  } finally {
    await closeLocalServer(local.server);
  }
});

test('GET /api/control-tasks/:id rejects an invalid awaiting clarification payload', async () => {
  const task = await repository.createTask({
    conversationId,
    ownerUserId,
    originalInput: `invalid-clarification-history-${randomUUID()}`,
    taskType: null,
    structuredTask: {},
    state: 'awaiting_clarification',
  });
  const app = await listenLocalApp(controlTasksApp({
    repository,
    workflow: new TaskWorkflowService(repository),
    getDeliverable: async () => null,
  }));
  try {
    const response = await fetch(`${app.baseUrl}/api/control-tasks/${task.id}`, {
      headers: {
        authorization: `Bearer ${signToken({ userId: ownerUserId, email: 'owner@test.local' })}`,
      },
    });
    assert.equal(response.status, 409, await response.clone().text());
    const body = await response.json() as { error: string };
    assert.match(body.error, /awaiting_clarification.*research-task-v2/i);
  } finally {
    await closeLocalServer(app.server);
  }
});

test('production control runtime completes a native Single report without the legacy report chain', async () => {
  const originalInput = '请生成基于公开证据的宠物辅食竞品研究计划';
  const { buildControlRuntime } = await loadControlRuntimeModule();
  const tavily = new OfflineRealTavilyAdapter();
  const llm = new OfflineEligibleRealLLM(['revise', 'pass', 'revise', 'block']);
  const tools = new ToolRouter().register(tavily);
  const artifacts = new ControlArtifactStore({ root: artifactRoot, registry: repository });
  const controlRuntime = await buildControlRuntime({
    repository,
    conversations: conversationAdapter(),
    planning: {
      async plan(input) {
        return planningResult(input.originalInput, undefined, true);
      },
    },
    tools,
    llm,
    validator: new SchemaValidator(),
    skillLoader: new SkillLoader(),
    artifacts,
  });

  const { createAgentApiApp } = await import('../apps/agent-api/src/server.ts');
  ({ closePool: closeSharedPool } = await import('../database/db.ts'));
  const createApp = createAgentApiApp as unknown as PlannedCreateAgentApiApp;
  server = createServer(createApp({ controlRuntime }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const ownerToken = signToken({ userId: ownerUserId, email: 'owner@test.local' });
  const foreignToken = signToken({ userId: foreignUserId, email: 'foreign@test.local' });

  const planResponse = await postJson(baseUrl, '/api/control-tasks/plan', ownerToken, {
    originalInput,
    conversationId,
    orchestrationMode: 'single_skill',
  });
  assert.equal(planResponse.status, 200, await planResponse.clone().text());
  const planned = await planResponse.json() as ControlPlanCandidatesResponse;
  assert.equal(planned.kind, 'current');
  assert.equal(planned.task.orchestrationMode, 'single_skill');
  const refreshedResponse = await fetch(`${baseUrl}/api/control-tasks/${planned.task.id}`, {
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  assert.equal(refreshedResponse.status, 200, await refreshedResponse.clone().text());
  const refreshed = await refreshedResponse.json() as {
    task: { originalInput: string; structuredTask: unknown; orchestrationMode?: string };
    activatedNodes: string[];
    candidates: ControlPlanCandidatesResponse['candidates'];
  };
  assert.equal(refreshed.task.originalInput, originalInput);
  assert.equal(refreshed.task.orchestrationMode, 'single_skill');
  assert.deepEqual(refreshed.task.structuredTask, planned.structuredTask);
  assert.deepEqual(refreshed.activatedNodes, planned.activatedNodes);
  assert.deepEqual(
    refreshed.candidates.map(({ planVersionId, candidateId, planHash }) => ({ planVersionId, candidateId, planHash })),
    planned.candidates.map(({ planVersionId, candidateId, planHash }) => ({ planVersionId, candidateId, planHash })),
  );
  assert.deepEqual(planned.candidates.map((candidate) => candidate.candidateId), ['depth', 'speed']);
  const foreignRefresh = await fetch(`${baseUrl}/api/control-tasks/${planned.task.id}`, {
    headers: { authorization: `Bearer ${foreignToken}` },
  });
  assert.equal(foreignRefresh.status, 404);
  const planningConnection = await scopedDatabase.connect();
  try {
    const persisted = await planningConnection.query(
      `SELECT
         (SELECT count(*)::int FROM control_tasks WHERE original_input = $1) AS tasks,
         (SELECT count(*)::int
          FROM control_plan_versions AS plan
          JOIN control_tasks AS task ON task.id = plan.task_id
          WHERE task.original_input = $1) AS candidates`,
      [originalInput],
    );
    assert.deepEqual(persisted.rows[0], { tasks: 1, candidates: 2 });
  } finally {
    planningConnection.release();
  }
  for (const candidate of planned.candidates) {
    assert.deepEqual(
      candidate.plan.steps.map((step) => step.actor_type),
      ['tool', 'skill'],
    );
  }
  const speed = planned.candidates.find((candidate) => candidate.candidateId === 'speed');
  assert.ok(speed);

  const selectResponse = await postJson(
    baseUrl,
    `/api/control-tasks/${planned.task.id}/select`,
    ownerToken,
    { expectedVersion: planned.task.stateVersion, planVersionId: speed.planVersionId },
    `select-${randomUUID()}`,
  );
  assert.equal(selectResponse.status, 200);
  const selected = await selectResponse.json() as { state: string; stateVersion: number };
  assert.equal(selected.state, 'awaiting_confirmation');

  const selectedRefreshResponse = await fetch(`${baseUrl}/api/control-tasks/${planned.task.id}`, {
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  assert.equal(selectedRefreshResponse.status, 200, await selectedRefreshResponse.clone().text());
  const selectedRefresh = await selectedRefreshResponse.json() as CurrentTaskReadResponse;
  assert.equal(selectedRefresh.task.state, 'awaiting_confirmation');
  assert.deepEqual(selectedRefresh.activePlan, speed);

  const legacyConfirmResponse = await postJson(
    baseUrl,
    `/api/control-tasks/${planned.task.id}/confirm`,
    ownerToken,
    {
      expectedVersion: selected.stateVersion,
      planVersionId: speed.planVersionId,
      confirmationAnswers: {},
      inputRoles: ['business_domain'],
    },
    `legacy-confirm-${randomUUID()}`,
  );
  assert.equal(legacyConfirmResponse.status, 400, await legacyConfirmResponse.clone().text());

  const confirmResponse = await postJson(
    baseUrl,
    `/api/control-tasks/${planned.task.id}/confirm`,
    ownerToken,
    {
      expectedVersion: selected.stateVersion,
      planVersionId: speed.planVersionId,
      confirmationAnswers: {},
      inputValues: {},
    },
    `confirm-${randomUUID()}`,
  );
  assert.equal(confirmResponse.status, 200, await confirmResponse.clone().text());
  const confirmed = await confirmResponse.json() as { state: string; stateVersion: number };
  assert.equal(confirmed.state, 'ready');

  const inputGateConnection = await scopedDatabase.connect();
  try {
    const persistedInputGate = await inputGateConnection.query(
      `SELECT gate_key, value_json
       FROM control_gate_records
       WHERE task_id = $1 AND plan_version_id = $2 AND gate_type = 'input'`,
      [planned.task.id, speed.planVersionId],
    );
    assert.deepEqual(persistedInputGate.rows, []);
  } finally {
    inputGateConnection.release();
  }

  const executeKey = `execute-${randomUUID()}`;
  const executeBody = { expectedVersion: confirmed.stateVersion, planVersionId: speed.planVersionId };
  const executeResponse = await postJson(
    baseUrl,
    `/api/control-tasks/${planned.task.id}/execute`,
    ownerToken,
    executeBody,
    executeKey,
  );
  if (executeResponse.status !== 200) {
    const failedTask = await repository.getTaskDetail(planned.task.id);
    const failedSteps = failedTask?.currentAttemptId
      ? await repository.listExecutionSteps(failedTask.currentAttemptId)
      : [];
    assert.fail(JSON.stringify({
      response: await executeResponse.clone().json(),
      state: failedTask?.state,
      failures: failedSteps.map((step) => step.failure),
    }));
  }
  assert.equal(executeResponse.status, 200, await executeResponse.clone().text());
  const execution = await executeResponse.json() as ExecutionResponse;
  assert.equal(execution.executionDisabled, false);
  assert.equal(execution.state, 'completed', JSON.stringify(execution));
  assert.equal(execution.status, 'completed', JSON.stringify(execution));
  assert.ok(execution.finalReportArtifactId);
  assert.ok(execution.evidenceManifestArtifactId);
  assert.match(execution.finalReportArtifactId, /^[0-9a-f-]{36}$/);
  assert.match(execution.evidenceManifestArtifactId, /^[0-9a-f-]{36}$/);
  assert.equal(execution.deliverableArtifactId, undefined);
  assert.equal(execution.reportReviewArtifactId, undefined);
  assert.equal(execution.reportPackageArtifactId, undefined);
  const replayResponse = await postJson(
    baseUrl,
    `/api/control-tasks/${planned.task.id}/execute`,
    ownerToken,
    executeBody,
    executeKey,
  );
  assert.equal(replayResponse.status, 200, await replayResponse.clone().text());
  const replayedExecution = await replayResponse.json() as ExecutionResponse;
  assert.equal(replayedExecution.finalReportArtifactId, execution.finalReportArtifactId);
  assert.equal(replayedExecution.attemptId, execution.attemptId);

  const finalResponse = await fetch(
    `${baseUrl}/api/control-tasks/${planned.task.id}/final-report`,
    { headers: { authorization: `Bearer ${ownerToken}` } },
  );
  assert.equal(finalResponse.status, 200, await finalResponse.clone().text());
  const finalReport = await finalResponse.json() as {
    version: string;
    taskId: string;
    planVersionId: string;
    attemptId: string;
    mode: string;
    primary: { format: string; content: string };
    skillResults: Array<{ invocationId: string; path: string }>;
  };
  assert.equal(finalReport.version, 'native-final-report-v1');
  assert.equal(finalReport.taskId, planned.task.id);
  assert.equal(finalReport.planVersionId, speed.planVersionId);
  assert.equal(finalReport.attemptId, execution.attemptId);
  assert.equal(finalReport.mode, 'single_skill');
  assert.equal(finalReport.skillResults.length, 1);
  assert.match(finalReport.primary.content, /^# 宠物辅食竞品分析/u);

  const skillResultsResponse = await fetch(
    `${baseUrl}/api/control-tasks/${planned.task.id}/skill-results`,
    { headers: { authorization: `Bearer ${ownerToken}` } },
  );
  assert.equal(skillResultsResponse.status, 200, await skillResultsResponse.clone().text());
  const skillResults = await skillResultsResponse.json() as {
    results: Array<{ version: string; invocationId: string; primary: { content: string } }>;
  };
  assert.equal(skillResults.results.length, 1);
  assert.equal(skillResults.results[0]?.version, 'native-skill-result-v1');
  assert.equal(skillResults.results[0]?.invocationId, finalReport.skillResults[0]?.invocationId);
  assert.ok(finalReport.primary.content.startsWith(skillResults.results[0]?.primary.content ?? 'missing'));

  const htmlResponse = await fetch(
    `${baseUrl}/api/control-tasks/${planned.task.id}/final-report.html`,
    { headers: { authorization: `Bearer ${ownerToken}` } },
  );
  assert.equal(htmlResponse.status, 200, await htmlResponse.clone().text());
  assert.equal(htmlResponse.headers.get('content-type'), 'text/html; charset=utf-8');
  const html = await htmlResponse.text();
  assert.match(html, /Content-Security-Policy/u);
  assert.doesNotMatch(html, /<script|<iframe|<form|onload=/u);

  for (const route of ['final-report', 'skill-results', 'final-report.html']) {
    const foreign = await fetch(`${baseUrl}/api/control-tasks/${planned.task.id}/${route}`, {
      headers: { authorization: `Bearer ${foreignToken}` },
    });
    assert.equal(foreign.status, 404);
  }

  const steps = await repository.listExecutionSteps(execution.attemptId);
  assert.deepEqual(
    steps.map(({ actorType, state }) => ({ actorType, state })),
    [
      { actorType: 'tool', state: 'succeeded' },
      { actorType: 'skill', state: 'succeeded' },
    ],
  );
  assert.equal(steps[0]?.toolProvenance?.executionMode, 'real');
  assert.equal(tavily.calls, 1);
  assert.equal(llm.skillContexts.length, 1);

  const artifactsForAttempt = await repository.listArtifactsForAttempt({
    taskId: planned.task.id,
    planVersionId: speed.planVersionId,
    attemptId: execution.attemptId,
  });
  const kinds = new Set(artifactsForAttempt.map(({ kind }) => kind));
  for (const expected of [
    'skill_result',
    'skill_result_primary',
    'final_report',
    'final_report_primary',
    'final_report_html',
    'report_sources',
  ]) assert.equal(kinds.has(expected), true, expected);
  for (const removed of [
    'deliverable',
    'report_review',
    'report_document',
    'report_package',
    'cross_skill_review',
    'contribution_ledger',
    'contribution_summary',
  ]) assert.equal(kinds.has(removed), false, removed);
});

test('production plan stream stops at the explicit direction gate before planning work', async () => {
  const { buildControlRuntime } = await loadControlRuntimeModule();
  const expectedModel = 'progress-planning-model';
  const controlRuntime = buildControlRuntime({
    repository,
    conversations: conversationAdapter(),
    tools: new ToolRouter(),
    llm: new PlanningModelFixtureLLM(expectedModel, expectedModel),
    validator: new SchemaValidator(),
    skillLoader: new SkillLoader(),
    artifacts: new ControlArtifactStore({ root: artifactRoot, registry: repository }),
    expectedActualModel: expectedModel,
  });
  const { createAgentApiApp } = await import('../apps/agent-api/src/server.ts');
  const app = await listenLocalApp(
    (createAgentApiApp as unknown as PlannedCreateAgentApiApp)({ controlRuntime }),
  );
  try {
    const response = await postJson(
      app.baseUrl,
      '/api/control-tasks/plan/stream',
      signToken({ userId: ownerUserId, email: 'owner@test.local' }),
      {
        originalInput: `progress-stream-${randomUUID()}`,
        conversationId,
        orchestrationMode: 'single_skill',
      },
    );
    assert.equal(response.status, 200);
    const events = parseSseEvents(await response.text());
    assert.deepEqual(events.map((event) => event.event), [
      'conversation',
      'result',
    ]);
    const result = events.at(-1)?.data as CurrentPlanningResponse;
    assert.equal(result.status, 'clarification_required');
    if (result.status !== 'clarification_required') throw new Error('expected direction clarification');
    assert.equal(result.task.state, 'awaiting_clarification');
    assert.equal(result.planningGuidance?.reasonCode, 'scenario_selection_required');
    assert.deepEqual(result.candidates, []);
  } finally {
    await closeLocalServer(app.server);
  }
});

test('production API persists Scenario selection guidance and resumes planning after a valid choice', async () => {
  const { buildControlRuntime } = await loadControlRuntimeModule();
  const expectedModel = 'scenario-selection-model';
  const runtime = buildControlRuntime({
    repository,
    conversations: conversationAdapter(),
    tools: new ToolRouter().register(new OfflineRealTavilyAdapter()),
    llm: new PlanningModelFixtureLLM(
      expectedModel,
      expectedModel,
      scenarioSelectionRequirement(),
    ),
    validator: new SchemaValidator(),
    skillLoader: new SkillLoader(),
    artifacts: new ControlArtifactStore({ root: artifactRoot, registry: repository }),
    expectedActualModel: expectedModel,
    multiSkillPortfolioMode: 'inactive',
  });
  const { createAgentApiApp } = await import('../apps/agent-api/src/server.ts');
  const app = await listenLocalApp(
    (createAgentApiApp as unknown as PlannedCreateAgentApiApp)({ controlRuntime: runtime }),
  );
  const token = signToken({ userId: ownerUserId, email: 'owner@test.local' });
  const authorization = { authorization: `Bearer ${token}` };
  const originalInput = '梳理宠物心智的设计表达策略全景';
  const expectedGuidance = {
    reasonCode: 'scenario_selection_required' as const,
    options: [
      { id: 'user-material-synthesis', label: '已有用户资料归纳' },
      { id: 'user-segmentation', label: '用户分层' },
      { id: 'user-journey-insight', label: '用户旅程与需求洞察' },
      { id: 'root-cause-analysis', label: '问题根因拆解' },
      { id: 'metrics-validation', label: '指标与验证计划' },
    ],
  };

  try {
    const plannedResponse = await postJson(app.baseUrl, '/api/control-tasks/plan', token, {
      originalInput,
      conversationId,
      orchestrationMode: 'single_skill',
    });
    assert.equal(plannedResponse.status, 200, await plannedResponse.clone().text());
    const planned = await plannedResponse.json() as CurrentPlanningResponse;
    assert.equal(planned.status, 'clarification_required');
    if (planned.status !== 'clarification_required') throw new Error('expected Scenario clarification');
    assert.equal(planned.task.state, 'awaiting_clarification');
    assert.deepEqual(planned.candidates, []);
    assert.deepEqual(planned.planningGuidance, expectedGuidance);

    const refreshedResponse = await fetch(
      `${app.baseUrl}/api/control-tasks/${planned.task.id}`,
      { headers: authorization },
    );
    assert.equal(refreshedResponse.status, 200, await refreshedResponse.clone().text());
    const refreshed = await refreshedResponse.json() as CurrentTaskReadResponse;
    assert.equal(refreshed.task.state, 'awaiting_clarification');
    assert.equal(refreshed.task.stateVersion, planned.task.stateVersion);
    assert.deepEqual(refreshed.planningGuidance, expectedGuidance);

    const invalidResponse = await postJson(
      app.baseUrl,
      `/api/control-tasks/${planned.task.id}/clarify`,
      token,
      {
        expectedVersion: planned.task.stateVersion,
        clarificationAnswers: {},
        assumptionEdits: {},
        selectedScenarioId: 'competitor-benchmark-research',
      },
      `scenario-invalid-${randomUUID()}`,
    );
    assert.equal(invalidResponse.status, 400, await invalidResponse.clone().text());
    assert.equal(
      (await invalidResponse.json() as { code?: string }).code,
      'invalid_scenario_selection',
    );

    const selectedResponse = await postJson(
      app.baseUrl,
      `/api/control-tasks/${planned.task.id}/clarify/stream`,
      token,
      {
        expectedVersion: planned.task.stateVersion,
        clarificationAnswers: {},
        assumptionEdits: {},
        selectedScenarioId: 'user-journey-insight',
      },
      `scenario-valid-${randomUUID()}`,
    );
    assert.equal(selectedResponse.status, 200, await selectedResponse.clone().text());
    const selectedEvents = parseSseEvents(await selectedResponse.text());
    assert.deepEqual(
      selectedEvents.slice(0, -1).map((event) => {
        const progress = event.data as { phase: string; status: string };
        return `${progress.phase}:${progress.status}`;
      }),
      [
        'understand:done',
        'activate:done',
        'guidance:done',
        'states:start',
        'states:done',
        'candidates:start',
        'candidates:done',
        'persist:start',
        'persist:done',
      ],
      JSON.stringify(selectedEvents.at(-1)),
    );
    assert.equal(selectedEvents.at(-1)?.event, 'result');
    const selected = selectedEvents.at(-1)?.data as ControlPlanCandidatesResponse;
    assert.equal(selected.task.state, 'awaiting_selection');
    assert.deepEqual(selected.candidates.map(({ candidateId }) => candidateId), [
      'speed',
      'depth',
      'focused',
      'mixed_method',
    ]);
    for (const candidate of selected.candidates) {
      const provenance = candidate.plan.planning_provenance;
      assert.ok(provenance);
      assert.equal(provenance.classification_method, 'clarification');
      assert.equal(provenance.classifier_call_count, 0);
      assert.equal(provenance.primary_scenario_id, 'user-journey-insight');
    }
  } finally {
    await closeLocalServer(app.server);
  }
});


test('production Current planning rejects model drift before candidate persistence and records a failed receipt', async () => {
  const { buildControlRuntime } = await loadControlRuntimeModule();
  const originalInput = `planning-model-drift-${randomUUID()}`;
  const expectedModel = 'expected-planning-model';
  const requestedModel = 'gateway-routing-alias';
  const actualModel = 'unexpected-planning-model';
  const receiptConnection = await scopedDatabase.connect();
  const existingReceipts = await receiptConnection.query(
    'SELECT id FROM control_model_calls WHERE attempt_id IS NULL',
  );
  receiptConnection.release();
  const runtime = buildControlRuntime({
    repository,
    conversations: conversationAdapter(),
    tools: new ToolRouter(),
    llm: new PlanningModelFixtureLLM(requestedModel, actualModel),
    validator: new SchemaValidator(),
    skillLoader: new SkillLoader(),
    artifacts: new ControlArtifactStore({ root: artifactRoot, registry: repository }),
    expectedActualModel: expectedModel,
    multiSkillPortfolioMode: 'inactive',
  });
  const { createAgentApiApp } = await import('../apps/agent-api/src/server.ts');
  const app = await listenLocalApp(
    (createAgentApiApp as unknown as PlannedCreateAgentApiApp)({ controlRuntime: runtime }),
  );
  try {
    const response = await postJson(
      app.baseUrl,
      '/api/control-tasks/plan',
      signToken({ userId: ownerUserId, email: 'owner@test.local' }),
      { originalInput, conversationId, orchestrationMode: 'single_skill' },
    );
    assert.equal(response.status, 502);
    assert.match(await response.text(), /model drift/i);
  } finally {
    await closeLocalServer(app.server);
  }

  const connection = await scopedDatabase.connect();
  try {
    const persisted = await connection.query(
      `SELECT
         (SELECT count(*)::int FROM control_tasks WHERE original_input = $1) AS tasks,
         (SELECT state FROM control_tasks WHERE original_input = $1) AS state,
         (SELECT count(*)::int
          FROM control_plan_versions AS plan
          JOIN control_tasks AS task ON task.id = plan.task_id
          WHERE task.original_input = $1) AS candidates`,
      [originalInput],
    );
    const receipts = await connection.query(
      `SELECT stage, requested_model, actual_model, status, failure_json
       FROM control_model_calls
       WHERE attempt_id IS NULL AND NOT (id = ANY($1::uuid[]))
       ORDER BY stage`,
      [existingReceipts.rows.map((row) => row.id)],
    );

    assert.deepEqual(persisted.rows[0], { tasks: 1, state: 'failed', candidates: 0 });
    assert.deepEqual(receipts.rows, [{
      stage: 'requirement_understanding',
      requested_model: requestedModel,
      actual_model: actualModel,
      status: 'failed',
      failure_json: {
        kind: 'model_drift',
        expectedModel,
        actualModel,
      },
    }]);
  } finally {
    connection.release();
  }
});

test('production Current planning persists candidates only when every receipt matches the model pin', async () => {
  const { buildControlRuntime } = await loadControlRuntimeModule();
  const originalInput = `planning-model-match-${randomUUID()}`;
  const expectedModel = 'expected-planning-model';
  const requestedModel = 'gateway-routing-alias';
  const receiptConnection = await scopedDatabase.connect();
  const existingReceipts = await receiptConnection.query(
    'SELECT id FROM control_model_calls WHERE attempt_id IS NULL',
  );
  receiptConnection.release();
  const runtime = buildControlRuntime({
    repository,
    conversations: conversationAdapter(),
    tools: new ToolRouter(),
    llm: new PlanningModelFixtureLLM(requestedModel, expectedModel),
    validator: new SchemaValidator(),
    skillLoader: new SkillLoader(),
    artifacts: new ControlArtifactStore({ root: artifactRoot, registry: repository }),
    expectedActualModel: expectedModel,
    multiSkillPortfolioMode: 'inactive',
  });
  // Delayed import preserves the test-controlled DB/JWT environment used by this integration file.
  const { createAgentApiApp } = await import('../apps/agent-api/src/server.ts');
  const app = await listenLocalApp(
    (createAgentApiApp as unknown as PlannedCreateAgentApiApp)({ controlRuntime: runtime }),
  );
  let planned: ControlPlanCandidatesResponse;
  try {
    const token = signToken({ userId: ownerUserId, email: 'owner@test.local' });
    const response = await postJson(
      app.baseUrl,
      '/api/control-tasks/plan',
      token,
      { originalInput, conversationId, orchestrationMode: 'single_skill' },
    );
    assert.equal(response.status, 200, await response.clone().text());
    const direction = await response.json() as CurrentPlanningResponse;
    assert.equal(direction.status, 'clarification_required');
    if (direction.status !== 'clarification_required') throw new Error('expected direction clarification');

    const selectedResponse = await postJson(
      app.baseUrl,
      `/api/control-tasks/${direction.task.id}/clarify`,
      token,
      {
        expectedVersion: direction.task.stateVersion,
        clarificationAnswers: {},
        assumptionEdits: {},
        selectedScenarioId: 'competitor-benchmark-research',
      },
      `model-match-direction-${randomUUID()}`,
    );
    assert.equal(selectedResponse.status, 200, await selectedResponse.clone().text());
    planned = await selectedResponse.json() as ControlPlanCandidatesResponse;
  } finally {
    await closeLocalServer(app.server);
  }

  const connection = await scopedDatabase.connect();
  try {
    const persisted = await connection.query(
      `SELECT
         (SELECT count(*)::int FROM control_tasks WHERE original_input = $1) AS tasks,
         (SELECT count(*)::int
          FROM control_plan_versions AS plan
          JOIN control_tasks AS task ON task.id = plan.task_id
          WHERE task.original_input = $1) AS candidates`,
      [originalInput],
    );
    const persistedPlans = await connection.query(
      `SELECT plan.plan_json
       FROM control_plan_versions AS plan
       JOIN control_tasks AS task ON task.id = plan.task_id
       WHERE task.original_input = $1
       ORDER BY plan.version`,
      [originalInput],
    );
    const receipts = await connection.query(
      `SELECT id, stage, requested_model, actual_model, prompt_hash, trace_id, status, failure_json
       FROM control_model_calls
       WHERE attempt_id IS NULL AND NOT (id = ANY($1::uuid[]))
       ORDER BY stage`,
      [existingReceipts.rows.map((row) => row.id)],
    );

    assert.equal(planned.task.state, 'awaiting_selection');
    assert.deepEqual(planned.candidates.map((candidate) => candidate.candidateId), [
      'speed',
      'depth',
      'breadth',
      'decision',
    ]);
    assert.deepEqual(persisted.rows[0], { tasks: 1, candidates: 4 });
    assert.deepEqual(
      receipts.rows.map((row) => ({
        stage: row.stage,
        requestedModel: row.requested_model,
        actualModel: row.actual_model,
        status: row.status,
        failure: row.failure_json,
      })),
      ['planning', 'planning_decision', 'problem_graph', 'requirement_understanding'].map((stage) => ({
        stage,
        requestedModel,
        actualModel: expectedModel,
        status: 'succeeded',
        failure: null,
      })),
    );
    const problemGraphReceipt = receipts.rows.find((row) => row.stage === 'problem_graph');
    assert.ok(problemGraphReceipt);
    assert.equal(persistedPlans.rows.length, 4);
    for (const row of persistedPlans.rows) {
      assertRecord(row.plan_json);
      assertRecord(row.plan_json.problem_graph_provenance);
      assert.deepEqual(row.plan_json.problem_graph_provenance, {
        receiptId: problemGraphReceipt.id,
        modelName: problemGraphReceipt.actual_model,
        modelVersion: `${expectedModel}-fixture-v1`,
        promptHash: problemGraphReceipt.prompt_hash,
        traceId: problemGraphReceipt.trace_id,
      });
    }
  } finally {
    connection.release();
  }
});

test('supplied foreign and missing planning conversations return 404 before creating a task', async () => {
  const { buildControlRuntime } = await loadControlRuntimeModule();
  const foreignConversation = await scopedDatabase.connect();
  let foreignConversationId = '';
  try {
    const result = await foreignConversation.query(
      `INSERT INTO conversations (owner_user_id, title) VALUES ($1, 'foreign planning conversation') RETURNING id`,
      [foreignUserId],
    );
    foreignConversationId = String(result.rows[0]?.id);
  } finally {
    foreignConversation.release();
  }
  const runtime = buildControlRuntime({
    repository,
    conversations: conversationAdapter(),
    planning: { async plan() { throw new Error('planning must not run'); } },
    tools: new ToolRouter(),
    llm: new OfflineEligibleRealLLM(),
    validator: new SchemaValidator(),
    skillLoader: new SkillLoader(),
    artifacts: new ControlArtifactStore({ root: artifactRoot, registry: repository }),
    expectedActualModel: 'fixture-real-model',
  });
  const { createAgentApiApp } = await import('../apps/agent-api/src/server.ts');
  const app = await listenLocalApp(
    (createAgentApiApp as unknown as PlannedCreateAgentApiApp)({ controlRuntime: runtime }),
  );
  const ownerToken = signToken({ userId: ownerUserId, email: 'owner@test.local' });
  const cases = [
    { conversationId: foreignConversationId, originalInput: `foreign-no-write-${randomUUID()}`, orchestrationMode: 'single_skill' },
    { conversationId: randomUUID(), originalInput: `missing-no-write-${randomUUID()}`, orchestrationMode: 'single_skill' },
  ];
  try {
    for (const target of cases) {
      const response = await postJson(app.baseUrl, '/api/control-tasks/plan', ownerToken, target);
      assert.equal(response.status, 404, await response.clone().text());
    }
    const connection = await scopedDatabase.connect();
    try {
      const tasks = await connection.query(
        'SELECT count(*)::int AS count FROM control_tasks WHERE original_input = ANY($1::text[])',
        [cases.map((target) => target.originalInput)],
      );
      assert.equal(tasks.rows[0]?.count, 0);
    } finally {
      connection.release();
    }
  } finally {
    await closeLocalServer(app.server);
  }
});

test('writeMessage reuses one assistant row for the same conversation idempotency key', async () => {
  const marker = `assistant-idempotency-${randomUUID()}`;
  const input = {
    conversationId,
    senderType: 'assistant' as const,
    messageType: 'text' as const,
    content: { marker },
    idempotencyKey: `requirement:${randomUUID()}:assistant`,
  };
  const first = await writeMessage(input);
  const second = await writeMessage(input);
  assert.equal(second.id, first.id);
  const connection = await scopedDatabase.connect();
  try {
    const count = await connection.query(
      'SELECT count(*)::int AS count FROM messages WHERE conversation_id = $1 AND content = $2::jsonb',
      [conversationId, JSON.stringify(input.content)],
    );
    assert.equal(count.rows[0]?.count, 1);
  } finally {
    connection.release();
  }
});

test('migration 005 preserves legacy completed commands and permits pending reservations', async () => {
  const compatibilitySchema = `command_reservation_compat_${randomUUID().replaceAll('-', '')}`;
  await database.query(`CREATE SCHEMA "${compatibilitySchema}"`);
  const client = await database.connect();
  try {
    await client.query(`SET search_path TO "${compatibilitySchema}", public`);
    await client.query(`
      CREATE TABLE control_commands (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        task_id UUID NOT NULL,
        command_type TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        expected_version BIGINT NOT NULL,
        state_before TEXT NOT NULL,
        state_after TEXT NOT NULL,
        response_json JSONB NOT NULL,
        actor_user_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (task_id, command_type, idempotency_key)
      )
    `);
    const legacyTaskId = randomUUID();
    await client.query(
      `INSERT INTO control_commands
         (task_id, command_type, idempotency_key, request_hash, expected_version,
          state_before, state_after, response_json)
       VALUES ($1, 'selection', 'legacy-key', 'sha256:legacy', 0,
               'awaiting_selection', 'awaiting_confirmation', $2)`,
      [legacyTaskId, JSON.stringify({ state: 'awaiting_confirmation', stateVersion: 1 })],
    );
    await client.query(readFileSync(
      join(process.cwd(), 'database', 'migrations', '005_clarification_command_reservation.sql'),
      'utf8',
    ));
    const upgraded = await client.query(
      `SELECT command_status, response_json, reservation_token, reservation_expires_at
       FROM control_commands WHERE task_id = $1`,
      [legacyTaskId],
    );
    assert.deepEqual(upgraded.rows[0], {
      command_status: 'completed',
      response_json: { state: 'awaiting_confirmation', stateVersion: 1 },
      reservation_token: null,
      reservation_expires_at: null,
    });
    await client.query(
      `INSERT INTO control_commands
         (task_id, command_type, idempotency_key, request_hash, expected_version,
          state_before, state_after, response_json, command_status,
          reservation_token, reservation_expires_at)
       VALUES ($1, 'clarification', 'pending-key', 'sha256:pending', 0,
               'awaiting_clarification', 'awaiting_clarification', NULL, 'pending', $2, now() + interval '1 minute')`,
      [randomUUID(), randomUUID()],
    );
  } finally {
    client.release();
    await database.query(`DROP SCHEMA IF EXISTS "${compatibilitySchema}" CASCADE`);
  }
});

test('migration 006 adds nullable message idempotency without changing legacy rows', async () => {
  const compatibilitySchema = `message_idempotency_compat_${randomUUID().replaceAll('-', '')}`;
  await database.query(`CREATE SCHEMA "${compatibilitySchema}"`);
  const client = await database.connect();
  try {
    await client.query(`SET search_path TO "${compatibilitySchema}", public`);
    await client.query(`
      CREATE TABLE messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        conversation_id UUID NOT NULL,
        sender_type TEXT NOT NULL,
        message_type TEXT NOT NULL,
        content JSONB NOT NULL,
        artifact_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    const conversation = randomUUID();
    await client.query(
      `INSERT INTO messages (conversation_id, sender_type, message_type, content)
       VALUES ($1, 'assistant', 'text', '{"legacy":true}')`,
      [conversation],
    );
    await client.query(readFileSync(
      join(process.cwd(), 'database', 'migrations', '006_message_idempotency.sql'),
      'utf8',
    ));
    const legacy = await client.query(
      'SELECT idempotency_key FROM messages WHERE conversation_id = $1',
      [conversation],
    );
    assert.deepEqual(legacy.rows, [{ idempotency_key: null }]);
    await client.query(
      `INSERT INTO messages (conversation_id, sender_type, message_type, content, idempotency_key)
       VALUES ($1, 'assistant', 'text', '{}', 'requirement:1:assistant')`,
      [conversation],
    );
    await assert.rejects(() => client.query(
      `INSERT INTO messages (conversation_id, sender_type, message_type, content, idempotency_key)
       VALUES ($1, 'assistant', 'text', '{}', 'requirement:1:assistant')`,
      [conversation],
    ));
    await client.query(
      `INSERT INTO messages (conversation_id, sender_type, message_type, content)
       VALUES ($1, 'assistant', 'text', '{}'), ($1, 'assistant', 'text', '{}')`,
      [conversation],
    );
  } finally {
    client.release();
    await database.query(`DROP SCHEMA IF EXISTS "${compatibilitySchema}" CASCADE`);
  }
});

test('migration 012 fails only incomplete clarification shells and is idempotent', async () => {
  const compatibilitySchema = `incomplete_clarification_compat_${randomUUID().replaceAll('-', '')}`;
  await database.query(`CREATE SCHEMA "${compatibilitySchema}"`);
  const client = await database.connect();
  try {
    await client.query(`SET search_path TO "${compatibilitySchema}", public`);
    await client.query(`
      CREATE TABLE control_tasks (
        id UUID PRIMARY KEY,
        state TEXT NOT NULL,
        state_version BIGINT NOT NULL,
        structured_task JSONB NOT NULL,
        active_requirement_version_id UUID,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    const shellId = randomUUID();
    const nonEmptyId = randomUUID();
    const activatedId = randomUUID();
    const completedId = randomUUID();
    await client.query(
      `INSERT INTO control_tasks
         (id, state, state_version, structured_task, active_requirement_version_id)
       VALUES
         ($1, 'awaiting_clarification', 0, '{}'::jsonb, NULL),
         ($2, 'awaiting_clarification', 3, '{"version":"research-task-v2"}'::jsonb, NULL),
         ($3, 'awaiting_clarification', 4, '{}'::jsonb, $5),
         ($4, 'completed', 5, '{}'::jsonb, NULL)`,
      [shellId, nonEmptyId, activatedId, completedId, randomUUID()],
    );
    const migration = readFileSync(
      join(process.cwd(), 'database', 'migrations', '012_fail_incomplete_clarification_tasks.sql'),
      'utf8',
    );
    await client.query(migration);
    await client.query(migration);
    const rows = await client.query(
      `SELECT id, state, state_version::int AS state_version
       FROM control_tasks
       ORDER BY id`,
    );
    const byId = new Map(rows.rows.map((row) => [String(row.id), row]));
    assert.deepEqual(byId.get(shellId), { id: shellId, state: 'failed', state_version: 1 });
    assert.deepEqual(byId.get(nonEmptyId), { id: nonEmptyId, state: 'awaiting_clarification', state_version: 3 });
    assert.deepEqual(byId.get(activatedId), { id: activatedId, state: 'awaiting_clarification', state_version: 4 });
    assert.deepEqual(byId.get(completedId), { id: completedId, state: 'completed', state_version: 5 });
  } finally {
    client.release();
    await database.query(`DROP SCHEMA IF EXISTS "${compatibilitySchema}" CASCADE`);
  }
});

test('migration 015 adds task orchestration mode idempotently', async () => {
  const compatibilitySchema = `task_orchestration_mode_${randomUUID().replaceAll('-', '')}`;
  await database.query(`CREATE SCHEMA "${compatibilitySchema}"`);
  const client = await database.connect();
  try {
    await client.query(`SET search_path TO "${compatibilitySchema}", public`);
    await client.query(`
      CREATE TABLE control_tasks (
        id UUID PRIMARY KEY,
        state TEXT NOT NULL
      )
    `);
    const migration = readFileSync(
      join(process.cwd(), 'database', 'migrations', '015_add_task_orchestration_mode.sql'),
      'utf8',
    );
    await client.query(migration);
    await client.query(migration);
    const columns = await client.query(
      `SELECT column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'control_tasks' AND column_name = 'orchestration_mode'`,
      [compatibilitySchema],
    );
    assert.deepEqual(columns.rows, [{ column_name: 'orchestration_mode', data_type: 'text' }]);
  } finally {
    client.release();
    await database.query(`DROP SCHEMA IF EXISTS "${compatibilitySchema}" CASCADE`);
  }
});

test('clarification idempotency is durable across concurrent and newly created routers', async () => {

  const created = await repository.createTask({
    conversationId,
    ownerUserId,
    originalInput: '$competitive-research compare pet supplements',
    taskType: 'competitive_research',
    structuredTask: clarificationRequirement(),
    state: 'awaiting_clarification',
  });
  const token = signToken({ userId: ownerUserId, email: 'owner@test.local' });
  let calls = 0;
  const signals = new EventEmitter();
  const blocked = once(signals, 'release');
  const pendingObserved = once(signals, 'pending');
  const duplicateCallObserved = once(signals, 'duplicate');
  const instrumentedRepository = Object.create(repository) as ControlPlaneRepository;
  instrumentedRepository.reserveCommand = async (input) => {
    const reservation = await repository.reserveCommand(input);
    if (reservation.status === 'pending') signals.emit('pending');
    return reservation;
  };
  const response = {
    kind: 'current' as const,
    status: 'clarification_required' as const,
    conversationId,
    task: { ...created },
    structuredTask: clarificationRequirement(),
    activatedNodes: [],
    candidates: [],
  };
  const runtime = {
    repository: instrumentedRepository,
    workflow: {},
    getDeliverable: async () => null,
    clarification: {
      async clarify() {
        calls += 1;
        if (calls > 1) signals.emit('duplicate');
        await blocked;
        return response;
      },
    },
  } as unknown as ControlTasksRuntime;
  const first = await listenLocalApp(controlTasksApp(runtime));
  const second = await listenLocalApp(controlTasksApp(runtime));
  const requestBody = {
    expectedVersion: created.stateVersion,
    clarificationAnswers: { audience: '产品团队' },
    assumptionEdits: {},
  };
  const key = `durable-${randomUUID()}`;
  try {
    const firstRequest = postJson(first.baseUrl, `/api/control-tasks/${created.id}/clarify`, token, requestBody, key);
    const concurrentRequest = postJson(second.baseUrl, `/api/control-tasks/${created.id}/clarify`, token, requestBody, key);
    await Promise.race([pendingObserved, duplicateCallObserved]);
    signals.emit('release');
    const [firstResponse, concurrentResponse] = await Promise.all([firstRequest, concurrentRequest]);
    assert.equal(firstResponse.status, 200, await firstResponse.clone().text());
    assert.equal(concurrentResponse.status, 200, await concurrentResponse.clone().text());
    assert.deepEqual(await concurrentResponse.json(), await firstResponse.json());
    assert.equal(calls, 1);

    const restarted = await listenLocalApp(controlTasksApp(runtime));
    try {
      const replay = await postJson(restarted.baseUrl, `/api/control-tasks/${created.id}/clarify`, token, requestBody, key);
      assert.equal(replay.status, 200, await replay.clone().text());
      assert.deepEqual(await replay.json(), response);
      assert.equal(calls, 1);
      const conflict = await postJson(restarted.baseUrl, `/api/control-tasks/${created.id}/clarify`, token, {
        ...requestBody,
        clarificationAnswers: { audience: '消费者' },
      }, key);
      assert.equal(conflict.status, 409);
      assert.equal(calls, 1);
    } finally {
      await closeLocalServer(restarted.server);
    }
  } finally {
    signals.emit('release');
    await Promise.all([closeLocalServer(first.server), closeLocalServer(second.server)]);
  }
});

test('failed clarification releases its pending command so a retry can complete', async () => {
  const created = await repository.createTask({
    conversationId,
    ownerUserId,
    originalInput: 'retry clarification after failure',
    taskType: 'competitive_research',
    structuredTask: clarificationRequirement(),
    state: 'awaiting_clarification',
  });
  const token = signToken({ userId: ownerUserId, email: 'owner@test.local' });
  let calls = 0;
  const response = {
    kind: 'current' as const,
    status: 'clarification_required' as const,
    conversationId,
    task: { ...created },
    structuredTask: clarificationRequirement(),
    activatedNodes: [],
    candidates: [],
  };
  const runtime = {
    repository,
    workflow: {},
    getDeliverable: async () => null,
    clarification: {
      async clarify() {
        calls += 1;
        if (calls === 1) throw new Error('simulated refinement failure');
        return response;
      },
    },
  } as unknown as ControlTasksRuntime;
  const first = await listenLocalApp(controlTasksApp(runtime));
  const second = await listenLocalApp(controlTasksApp(runtime));
  const requestBody = {
    expectedVersion: created.stateVersion,
    clarificationAnswers: { audience: '产品团队' },
    assumptionEdits: {},
  };
  const key = `release-${randomUUID()}`;
  try {
    const failed = await postJson(first.baseUrl, `/api/control-tasks/${created.id}/clarify`, token, requestBody, key);
    assert.equal(failed.status, 500);
    assert.equal(await repository.getCommand(created.id, 'clarification', key), null);

    const retried = await postJson(second.baseUrl, `/api/control-tasks/${created.id}/clarify`, token, requestBody, key);
    assert.equal(retried.status, 200, await retried.clone().text());
    assert.deepEqual((await repository.getCommand(created.id, 'clarification', key))?.response, response);
    assert.equal(calls, 2);
  } finally {
    await Promise.all([closeLocalServer(first.server), closeLocalServer(second.server)]);
  }
});

test('post-activation clarification failure reclaims the same command without another requirement version', async () => {
  const { buildControlRuntime } = await loadControlRuntimeModule();
  const llm = new ClarificationRetryLLM();
  let plannerCalls = 0;
  const controlRuntime = buildControlRuntime({
    repository,
    conversations: conversationAdapter(),
    planning: {
      async plan(input) {
        plannerCalls += 1;
        if (plannerCalls === 1) throw new Error('simulated post-activation planner failure');
        return planningResult(input.originalInput, resolvedClarificationRequirement());
      },
    },
    tools: new ToolRouter(),
    llm,
    validator: new SchemaValidator(),
    skillLoader: new SkillLoader(),
    artifacts: new ControlArtifactStore({ root: artifactRoot, registry: repository }),
    expectedActualModel: llm.identity.requestedModel,
  });
  const { createAgentApiApp } = await import('../apps/agent-api/src/server.ts');
  const app = await listenLocalApp(
    (createAgentApiApp as unknown as PlannedCreateAgentApiApp)({ controlRuntime }),
  );
  const token = signToken({ userId: ownerUserId, email: 'owner@test.local' });
  const originalInput = `post-activation-retry-${randomUUID()}`;
  try {
    const plannedResponse = await postJson(app.baseUrl, '/api/control-tasks/plan', token, {
      originalInput,
      conversationId,
      orchestrationMode: 'single_skill',
    });
    assert.equal(plannedResponse.status, 200, await plannedResponse.clone().text());
    const planned = await plannedResponse.json() as CurrentPlanningResponse;
    assert.equal(planned.status, 'clarification_required');
    const requestBody = {
      expectedVersion: planned.task.stateVersion,
      clarificationAnswers: { audience: '产品团队' },
      assumptionEdits: {},
    };
    const key = `post-activation-${randomUUID()}`;

    const failed = await postJson(
      app.baseUrl,
      `/api/control-tasks/${planned.task.id}/clarify`,
      token,
      requestBody,
      key,
    );
    assert.equal(failed.status, 500);
    const afterFailure = await scopedDatabase.connect();
    try {
      const persisted = await afterFailure.query(
        `SELECT
           (SELECT count(*)::int FROM control_requirement_versions WHERE task_id = $1) AS requirement_versions,
           (SELECT state_version::int FROM control_tasks WHERE id = $1) AS state_version,
           (SELECT command_status FROM control_commands
             WHERE task_id = $1 AND command_type = 'clarification' AND idempotency_key = $2) AS command_status,
           (SELECT reservation_expires_at <= now() FROM control_commands
             WHERE task_id = $1 AND command_type = 'clarification' AND idempotency_key = $2) AS reclaimable`,
        [planned.task.id, key],
      );
      assert.deepEqual(persisted.rows[0], {
        requirement_versions: 2,
        state_version: planned.task.stateVersion + 1,
        command_status: 'pending',
        reclaimable: true,
      });
    } finally {
      afterFailure.release();
    }

    const retried = await postJson(
      app.baseUrl,
      `/api/control-tasks/${planned.task.id}/clarify`,
      token,
      requestBody,
      key,
    );
    assert.equal(retried.status, 200, await retried.clone().text());
    const retriedBody = await retried.json() as ControlPlanCandidatesResponse;
    assert.equal(retriedBody.kind, 'current');
    assert.equal(retriedBody.task.id, planned.task.id);
    assert.deepEqual(retriedBody.candidates.map((candidate) => candidate.candidateId), ['depth', 'speed']);
    const replay = await postJson(
      app.baseUrl,
      `/api/control-tasks/${planned.task.id}/clarify`,
      token,
      requestBody,
      key,
    );
    assert.equal(replay.status, 200, await replay.clone().text());
    assert.deepEqual(await replay.json(), retriedBody);

    const conflict = await postJson(
      app.baseUrl,
      `/api/control-tasks/${planned.task.id}/clarify`,
      token,
      { ...requestBody, clarificationAnswers: { audience: '消费者' } },
      key,
    );
    assert.equal(conflict.status, 409);

    const afterSuccess = await scopedDatabase.connect();
    try {
      const versions = await afterSuccess.query(
        'SELECT count(*)::int AS count FROM control_requirement_versions WHERE task_id = $1',
        [planned.task.id],
      );
      assert.equal(versions.rows[0]?.count, 2);
    } finally {
      afterSuccess.release();
    }
    assert.equal(llm.requirementCalls, 2, 'retry must not rerun requirement understanding');
    assert.equal(plannerCalls, 2, 'retry may rerun downstream planning exactly once');
  } finally {
    await closeLocalServer(app.server);
  }
});

test('latest-version fresh-key clarification recovers hydrated unchanged assumptions after refresh', async () => {
  const { buildControlRuntime } = await loadControlRuntimeModule();
  const llm = new ClarificationRetryLLM();
  let plannerCalls = 0;
  const controlRuntime = buildControlRuntime({
    repository,
    conversations: conversationAdapter(),
    planning: {
      async plan(input) {
        plannerCalls += 1;
        if (plannerCalls === 1) throw new Error('simulated post-activation planner failure before candidate persistence');
        return planningResult(input.originalInput, resolvedClarificationRequirement());
      },
    },
    tools: new ToolRouter(),
    llm,
    validator: new SchemaValidator(),
    skillLoader: new SkillLoader(),
    artifacts: new ControlArtifactStore({ root: artifactRoot, registry: repository }),
    expectedActualModel: llm.identity.requestedModel,
  });
  const { createAgentApiApp } = await import('../apps/agent-api/src/server.ts');
  const app = await listenLocalApp(
    (createAgentApiApp as unknown as PlannedCreateAgentApiApp)({ controlRuntime }),
  );
  const token = signToken({ userId: ownerUserId, email: 'owner@test.local' });
  const originalInput = `latest-version-fresh-key-recovery-${randomUUID()}`;
  try {
    const plannedResponse = await postJson(app.baseUrl, '/api/control-tasks/plan', token, {
      originalInput,
      conversationId,
      orchestrationMode: 'single_skill',
    });
    assert.equal(plannedResponse.status, 200, await plannedResponse.clone().text());
    const planned = await plannedResponse.json() as CurrentPlanningResponse;
    assert.equal(planned.status, 'clarification_required');

    const failedKey = `post-activation-failure-${randomUUID()}`;
    const failed = await postJson(
      app.baseUrl,
      `/api/control-tasks/${planned.task.id}/clarify`,
      token,
      {
        expectedVersion: planned.task.stateVersion,
        clarificationAnswers: { audience: '产品团队' },
        assumptionEdits: {},
      },
      failedKey,
    );
    assert.equal(failed.status, 500);
    assert.equal(llm.requirementCalls, 2);

    const beforeRecoveryConnection = await scopedDatabase.connect();
    let requirementVersionsBeforeRecovery = 0;
    try {
      const beforeRecovery = await beforeRecoveryConnection.query(
        `SELECT
           (SELECT count(*)::int FROM control_requirement_versions WHERE task_id = $1) AS requirement_versions,
           (SELECT count(*)::int FROM control_plan_versions WHERE task_id = $1) AS plans`,
        [planned.task.id],
      );
      requirementVersionsBeforeRecovery = Number(beforeRecovery.rows[0]?.requirement_versions);
      assert.deepEqual(beforeRecovery.rows[0], { requirement_versions: 2, plans: 0 });
    } finally {
      beforeRecoveryConnection.release();
    }

    const refreshedResponse = await fetch(`${app.baseUrl}/api/control-tasks/${planned.task.id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(refreshedResponse.status, 200, await refreshedResponse.clone().text());
    const refreshed = await refreshedResponse.json() as CurrentTaskReadResponse;
    assert.equal(refreshed.task.state, 'awaiting_clarification');
    assert.equal(refreshed.task.stateVersion, planned.task.stateVersion + 1);
    assert.deepEqual(refreshed.task.structuredTask, resolvedClarificationRequirement());
    const refreshedRequirement = refreshed.task.structuredTask as ResearchTaskV2;
    assert.deepEqual(refreshedRequirement.ambiguities, []);
    assert.deepEqual(refreshedRequirement.clarification_questions, []);
    assert.deepEqual(refreshedRequirement.blocking_issues, []);
    assert.deepEqual(refreshed.candidates, []);
    const hydratedAssumptionEdits = Object.fromEntries(
      refreshedRequirement.assumptions
        .filter(({ editable }) => editable)
        .map(({ key, value }) => [key, value]),
    );
    assert.deepEqual(hydratedAssumptionEdits, { scope: '公开资料' });

    const freshKey = `refreshed-finalized-recovery-${randomUUID()}`;
    assert.notEqual(freshKey, failedKey);
    const recoveredResponse = await postJson(
      app.baseUrl,
      `/api/control-tasks/${planned.task.id}/clarify`,
      token,
      {
        expectedVersion: refreshed.task.stateVersion,
        clarificationAnswers: {},
        assumptionEdits: hydratedAssumptionEdits,
      },
      freshKey,
    );
    assert.equal(recoveredResponse.status, 200, await recoveredResponse.clone().text());
    const recovered = await recoveredResponse.json() as ControlPlanCandidatesResponse;
    assert.equal(recovered.task.state, 'awaiting_selection');
    assert.deepEqual(recovered.candidates.map((candidate) => candidate.candidateId), ['depth', 'speed']);

    const afterRecoveryConnection = await scopedDatabase.connect();
    try {
      const afterRecovery = await afterRecoveryConnection.query(
        `SELECT
           (SELECT count(*)::int FROM control_requirement_versions WHERE task_id = $1) AS requirement_versions,
           (SELECT count(*)::int FROM control_plan_versions WHERE task_id = $1) AS plans,
           (SELECT command_status FROM control_commands
             WHERE task_id = $1 AND command_type = 'clarification' AND idempotency_key = $2) AS command_status`,
        [planned.task.id, freshKey],
      );
      assert.deepEqual(afterRecovery.rows[0], {
        requirement_versions: requirementVersionsBeforeRecovery,
        plans: 2,
        command_status: 'completed',
      });
    } finally {
      afterRecoveryConnection.release();
    }
    assert.equal(llm.requirementCalls, 2, 'refresh recovery must reuse the finalized active requirement');
    assert.equal(plannerCalls, 2);
  } finally {
    await closeLocalServer(app.server);
  }
});

test('response delivery failure after atomic clarification commit replays the persisted response', async () => {
  const { buildControlRuntime } = await loadControlRuntimeModule();
  const llm = new ClarificationRetryLLM();
  const instrumentedRepository = Object.create(repository) as ControlPlaneRepository;
  let failResponseDelivery = true;
  let atomicCalls = 0;
  instrumentedRepository.persistClarificationCandidatesAndCompleteCommand = async (input) => {
    atomicCalls += 1;
    const response = await repository.persistClarificationCandidatesAndCompleteCommand(input);
    if (failResponseDelivery) {
      failResponseDelivery = false;
      throw new Error('simulated HTTP response delivery failure after commit');
    }
    return response;
  };
  let plannerCalls = 0;
  const controlRuntime = buildControlRuntime({
    repository: instrumentedRepository,
    conversations: conversationAdapter(),
    planning: {
      async plan(input) {
        plannerCalls += 1;
        return planningResult(input.originalInput, resolvedClarificationRequirement());
      },
    },
    tools: new ToolRouter(),
    llm,
    validator: new SchemaValidator(),
    skillLoader: new SkillLoader(),
    artifacts: new ControlArtifactStore({ root: artifactRoot, registry: instrumentedRepository }),
    expectedActualModel: llm.identity.requestedModel,
  });
  const { createAgentApiApp } = await import('../apps/agent-api/src/server.ts');
  const app = await listenLocalApp(
    (createAgentApiApp as unknown as PlannedCreateAgentApiApp)({ controlRuntime }),
  );
  const token = signToken({ userId: ownerUserId, email: 'owner@test.local' });
  try {
    const plannedResponse = await postJson(app.baseUrl, '/api/control-tasks/plan', token, {
      originalInput: `response-delivery-replay-${randomUUID()}`,
      conversationId,
      orchestrationMode: 'single_skill',
    });
    assert.equal(plannedResponse.status, 200, await plannedResponse.clone().text());
    const planned = await plannedResponse.json() as CurrentPlanningResponse;
    assert.equal(planned.status, 'clarification_required');
    const key = `response-delivery-${randomUUID()}`;
    const requestBody = {
      expectedVersion: planned.task.stateVersion,
      clarificationAnswers: { audience: '产品团队' },
      assumptionEdits: {},
    };

    const failed = await postJson(
      app.baseUrl,
      `/api/control-tasks/${planned.task.id}/clarify`,
      token,
      requestBody,
      key,
    );
    assert.equal(failed.status, 500);
    const persistedResponse = (
      await repository.getCommand(planned.task.id, 'clarification', key)
    )?.response as ControlPlanCandidatesResponse;
    assert.equal(persistedResponse.task.state, 'awaiting_selection');
    const recoveredResponse = await fetch(`${app.baseUrl}/api/control-tasks/${planned.task.id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(recoveredResponse.status, 200, await recoveredResponse.clone().text());
    const recovered = await recoveredResponse.json() as {
      candidates: ControlPlanCandidatesResponse['candidates'];
      activatedNodes: string[];
    };
    assert.deepEqual(
      recovered.candidates.map(({ planVersionId, candidateId, planHash }) => ({ planVersionId, candidateId, planHash })),
      persistedResponse.candidates.map(({ planVersionId, candidateId, planHash }) => ({ planVersionId, candidateId, planHash })),
    );
    assert.deepEqual(recovered.activatedNodes, persistedResponse.activatedNodes);
    const repeatedRecovery = await fetch(`${app.baseUrl}/api/control-tasks/${planned.task.id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(repeatedRecovery.status, 200);

    const connection = await scopedDatabase.connect();
    try {
      const persisted = await connection.query(
        `SELECT
           (SELECT count(*)::int FROM control_plan_versions WHERE task_id = $1) AS plans,
           (SELECT count(*)::int
              FROM messages
             WHERE conversation_id = $2
               AND idempotency_key = 'requirement:' ||
                 (SELECT active_requirement_version_id::text FROM control_tasks WHERE id = $1) ||
                 ':assistant') AS assistant_messages`,
        [planned.task.id, conversationId],
      );
      assert.deepEqual(persisted.rows[0], { plans: 2, assistant_messages: 1 });
    } finally {
      connection.release();
    }

    const replay = await postJson(
      app.baseUrl,
      `/api/control-tasks/${planned.task.id}/clarify`,
      token,
      requestBody,
      key,
    );
    assert.equal(replay.status, 200, await replay.clone().text());
    assert.deepEqual(await replay.json(), persistedResponse);
    assert.equal(atomicCalls, 1);
    assert.equal(plannerCalls, 1);
    assert.equal(llm.requirementCalls, 2);
  } finally {
    await closeLocalServer(app.server);
  }
});

test('expired clarification reservations are reclaimed with token fencing', async () => {
  const created = await repository.createTask({
    conversationId,
    ownerUserId,
    originalInput: 'reclaim expired clarification reservation',
    taskType: 'competitive_research',
    structuredTask: clarificationRequirement(),
    state: 'awaiting_clarification',
  });
  const input = {
    taskId: created.id,
    commandType: 'clarification',
    idempotencyKey: `reclaim-${randomUUID()}`,
    requestHash: `sha256:${'a'.repeat(64)}`,
    expectedVersion: created.stateVersion,
    actorUserId: ownerUserId,
  };
  const first = await repository.reserveCommand(input);
  assert.equal(first.status, 'reserved');
  assert.ok(first.reservationToken);
  const connection = await scopedDatabase.connect();
  try {
    await connection.query(
      `UPDATE control_commands
       SET reservation_expires_at = now() - interval '1 second'
       WHERE task_id = $1 AND command_type = $2 AND idempotency_key = $3`,
      [input.taskId, input.commandType, input.idempotencyKey],
    );
  } finally {
    connection.release();
  }
  const reclaimed = await repository.reserveCommand(input);
  assert.equal(reclaimed.status, 'reserved');
  assert.ok(reclaimed.reservationToken);
  assert.notEqual(reclaimed.reservationToken, first.reservationToken);
  await assert.rejects(() => repository.completeCommand({
    ...input,
    reservationToken: first.reservationToken!,
    stateAfter: 'awaiting_clarification',
    response: { stale: true },
  }), /reservation|fence|lost/i);
  await repository.completeCommand({
    ...input,
    reservationToken: reclaimed.reservationToken!,
    stateAfter: 'awaiting_clarification',
    response: { reclaimed: true },
  });
  assert.deepEqual((await repository.getCommand(input.taskId, input.commandType, input.idempotencyKey))?.response, { reclaimed: true });
});

test('clarification route rejects tasks outside awaiting_clarification before refinement', async () => {
  const created = await repository.createTask({
    conversationId,
    ownerUserId,
    originalInput: 'selection cannot be clarified',
    taskType: 'competitive_research',
    structuredTask: clarificationRequirement(),
    state: 'awaiting_selection',
  });
  let calls = 0;
  const runtime = {
    repository,
    workflow: {},
    getDeliverable: async () => null,
    clarification: { async clarify() { calls += 1; throw new Error('must not run'); } },
  } as unknown as ControlTasksRuntime;
  const app = await listenLocalApp(controlTasksApp(runtime));
  try {
    const response = await postJson(
      app.baseUrl,
      `/api/control-tasks/${created.id}/clarify`,
      signToken({ userId: ownerUserId, email: 'owner@test.local' }),
      { expectedVersion: created.stateVersion, clarificationAnswers: {}, assumptionEdits: {} },
      `state-gate-${randomUUID()}`,
    );
    assert.equal(response.status, 409);
    assert.equal(calls, 0);
  } finally {
    await closeLocalServer(app.server);
  }
});

test('repository commits one owner-bound report follow-up turn and replays its command', async () => {
  const created = await repository.createTask({
    conversationId,
    ownerUserId,
    originalInput: 'completed report follow-up',
    taskType: 'competitive_research',
    structuredTask: { research_goal: '解释报告' },
    state: 'completed',
  });
  const idempotencyKey = `follow-up-${randomUUID()}`;
  const requestHash = `sha256:${'a'.repeat(64)}`;
  const reservation = await repository.reserveFollowUpCommand({
    taskId: created.id,
    idempotencyKey,
    requestHash,
    expectedVersion: created.stateVersion,
    actorUserId: ownerUserId,
  });
  assert.equal(reservation.status, 'reserved');
  if (reservation.status !== 'reserved') return;
  const createdAt = new Date().toISOString();
  const response: TaskFollowUpResponse = {
    messages: [{
      version: 'task-follow-up-message-v1',
      id: randomUUID(),
      taskId: created.id,
      role: 'user',
      content: '为什么优先处理这个问题？',
      sourceIds: [],
      gaps: [],
      createdAt,
    }, {
      version: 'task-follow-up-message-v1',
      id: randomUUID(),
      taskId: created.id,
      role: 'assistant',
      content: '因为该问题直接影响主流程完成率。',
      sourceIds: ['S-1'],
      gaps: [],
      createdAt,
    }],
  };
  await repository.completeFollowUpCommand({
    taskId: created.id,
    conversationId,
    idempotencyKey,
    requestHash,
    expectedVersion: created.stateVersion,
    reservationToken: reservation.reservationToken,
    state: 'completed',
    finalReportArtifactId: randomUUID(),
    response,
  });

  assert.deepEqual(await repository.listTaskFollowUps({ taskId: created.id, ownerUserId }), response.messages);
  assert.deepEqual(await repository.listTaskFollowUps({ taskId: created.id, ownerUserId: foreignUserId }), []);
  assert.deepEqual(await repository.reserveFollowUpCommand({
    taskId: created.id,
    idempotencyKey,
    requestHash,
    expectedVersion: created.stateVersion,
    actorUserId: ownerUserId,
  }), { status: 'replay', response });
});

test('report follow-up routes stay task-scoped and require an idempotency key', async () => {
  const created = await repository.createTask({
    conversationId,
    ownerUserId,
    originalInput: 'follow-up route',
    taskType: 'competitive_research',
    structuredTask: { research_goal: '解释报告' },
    state: 'completed',
  });
  const createdAt = new Date().toISOString();
  const response: TaskFollowUpResponse = {
    messages: [{
      version: 'task-follow-up-message-v1', id: randomUUID(), taskId: created.id,
      role: 'user', content: '解释结论', sourceIds: [], gaps: [], createdAt,
    }, {
      version: 'task-follow-up-message-v1', id: randomUUID(), taskId: created.id,
      role: 'assistant', content: '这是基于报告的解释。', sourceIds: [], gaps: [], createdAt,
    }],
  };
  let createCalls = 0;
  const runtime = {
    repository,
    workflow: {} as TaskWorkflowService,
    getDeliverable: async () => null,
    getFinalReport: async () => ({
      artifact: { id: randomUUID(), contentSha256: `sha256:${'b'.repeat(64)}` },
      report: {
        version: HISTORICAL_FINAL_REPORT_VERSION,
        taskId: created.id,
        planVersionId: randomUUID(),
        attemptId: randomUUID(),
        mode: 'single_skill',
        title: '历史报告',
        markdown: '# 报告',
        sources: [],
        gaps: [],
        skillReports: [{
          skillId: 'competitive-analysis', invocationId: 'competitive-analysis:1',
          status: 'completed', path: 'skill-results/competitive-analysis.json',
        }],
      },
    }),
    followUps: {
      async list() { return response.messages; },
      async create() { createCalls += 1; return response; },
    },
  } as unknown as ControlTasksRuntime;
  const app = await listenLocalApp(controlTasksApp(runtime));
  const ownerToken = signToken({ userId: ownerUserId, email: 'owner@test.local' });
  const foreignToken = signToken({ userId: foreignUserId, email: 'foreign@test.local' });
  try {
    const listed = await fetch(`${app.baseUrl}/api/control-tasks/${created.id}/follow-ups`, {
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(listed.status, 200);
    assert.deepEqual((await listed.json() as TaskFollowUpResponse).messages, response.messages);

    const missingKey = await postJson(
      app.baseUrl,
      `/api/control-tasks/${created.id}/follow-ups`,
      ownerToken,
      { message: '解释结论' },
    );
    assert.equal(missingKey.status, 400);
    assert.equal(createCalls, 0);

    const createdResponse = await postJson(
      app.baseUrl,
      `/api/control-tasks/${created.id}/follow-ups`,
      ownerToken,
      { message: '解释结论' },
      randomUUID(),
    );
    assert.equal(createdResponse.status, 200);
    assert.equal(createCalls, 1);

    const foreign = await fetch(`${app.baseUrl}/api/control-tasks/${created.id}/follow-ups`, {
      headers: { authorization: `Bearer ${foreignToken}` },
    });
    assert.equal(foreign.status, 404);
  } finally {
    await closeLocalServer(app.server);
  }
});

test('task status route returns only lightweight execution state', async () => {
  const created = await repository.createTask({
    conversationId,
    ownerUserId,
    originalInput: 'lightweight status',
    taskType: 'competitive_research',
    structuredTask: { research_goal: '读取状态' },
    state: 'ready',
  });
  const runtime = {
    repository,
    workflow: {} as TaskWorkflowService,
    getDeliverable: async () => null,
  } as unknown as ControlTasksRuntime;
  const app = await listenLocalApp(controlTasksApp(runtime));
  try {
    const response = await fetch(`${app.baseUrl}/api/control-tasks/${created.id}/status`, {
      headers: {
        authorization: `Bearer ${signToken({ userId: ownerUserId, email: 'owner@test.local' })}`,
      },
    });
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), [
      'currentAttemptId', 'executionSteps', 'state', 'stateVersion', 'taskId',
    ]);
    assert.equal(body.state, 'ready');
    assert.equal(JSON.stringify(body).includes('activePlan'), false);
  } finally {
    await closeLocalServer(app.server);
  }
});
