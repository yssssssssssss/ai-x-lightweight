import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  assertGatewayModelReceipts,
  assertVirtualUserLabReady,
  assertMultiSkillSmokePlan,
  assertRealSmokeConfig,
  assertSmokePlanApprovalPolicy,
  assertSmokeReceiptMinimums,
  CURRENT_REAL_SMOKE_PROFILES,
  designSmokeInputValue,
  formatSmokeReceipt,
  mayAutoApproveSmoke,
  readEditorialSummaryWithOneRetry,
  resolveSmokeReportContract,
  resolveApprovalMode,
  resolveSmokeRequirement,
  requireActorCoverage,
  runCurrentRealSmoke,
  safeSmokeErrorMessage,
  selectSmokeScenario,
  selectSmokeCandidate,
  SmokeInfrastructureError,
  summarizeSmokeEvidence,
  verifyEditorialSummaryForSmoke,
  verifySmokeGapSummaryHashes,
  verifySmokeHistoryReread,
} from '../scripts/current-real-smoke.ts';
import { parseModelRoutes } from '../apps/orchestrator-runtime/src/runtime/gateway-llm-client.ts';
test('JD crowdfunding native real-smoke contract requires its Contributor subset and one real Tool stage', () => {
  const fixture = JSON.parse(readFileSync(
    join(process.cwd(), 'tests/fixtures/jd-crowdfunding-multi-skill-real-smoke.json'),
    'utf8',
  )) as { scenarios: Array<{
    requireMultiSkill: boolean;
    expectedContributorSkillIds: string[];
    requiredToolIds: string[];
  }> };
  const scenario = fixture.scenarios[0]!;
  const contributorInvocations = scenario.expectedContributorSkillIds.map((skillId, index) => ({
    invocation_id: `contributor-${index}`,
    skill_id: skillId,
  }));
  const plan = {
    execution_contract_version: 'native-skill-execution-plan-v1',
    skill_invocations: contributorInvocations,
    steps: [
      { actor_type: 'tool', actor_id: 'tavily-web-search' },
    ],
  };
  assert.doesNotThrow(() => assertMultiSkillSmokePlan(plan, scenario));
  assert.doesNotThrow(() => assertMultiSkillSmokePlan({
    ...plan,
    skill_invocations: [...plan.skill_invocations, { skill_id: 'issue-prioritization' }],
  }, scenario));
  assert.throws(
    () => assertMultiSkillSmokePlan({ ...plan, execution_contract_version: 'current-execution-plan-v2' }, scenario),
    /NativeSkillExecutionPlan v1/u,
  );
  assert.throws(
    () => assertMultiSkillSmokePlan({ ...plan, skill_invocations: plan.skill_invocations.slice(1) }, scenario),
    /Contributor inventory/u,
  );
});

const REQUIRED_REAL_PROVIDER_ENV = [
  'ALLOW_REAL_PROVIDER',
  'LLM_PROVIDER',
  'TOOL_ADAPTER',
  'DATABASE_URL',
  'JWT_SECRET',
  'LLM_GATEWAY_BASE_URL',
  'LLM_GATEWAY_API_KEY',
  'LLM_MODEL_NAME',
  'LLM_EXPECTED_ACTUAL_MODEL',
  'TAVILY_API_KEY',
  'CURRENT_DESIGN_SMOKE_IMAGE_PATH',
] as const;
const realProviderConfigured = REQUIRED_REAL_PROVIDER_ENV.every((key) => {
  const value = process.env[key];
  return typeof value === 'string' && value.trim() !== '';
});
const realSmokeOptions = { skip: !realProviderConfigured };
const realSmokeScenarios = [
  { profile: 'competitive_research', scenarioId: 'competitive-ai-shopping-assistant' },
  { profile: 'user_research_planning', scenarioId: 'planning-checkout-abandonment' },
  { profile: 'research_synthesis', scenarioId: 'answer-pet-food-mindshare' },
  { profile: 'voc_diagnosis', scenarioId: 'voc-checkout' },
  { profile: 'design_audit', scenarioId: 'design-product-detail' },
  { profile: 'a11y_audit', scenarioId: 'a11y-mobile-checkout' },
  { profile: 'industry_market_analysis', scenarioId: 'industry-pet-food-public' },
] as const;
const realProfiles = realSmokeScenarios.map(({ profile }) => profile);

type SmokeReceipt = {
  scenarioId: string;
  profile: string;
  taskType: string;
  deliverableType: string;
  taskId: string;
  planVersionId: string;
  attemptId: string;
  contract: 'native';
  finalReportArtifactId: string;
  skillResultArtifactIds: string[];
  visualAssetCount: number;
  gapCount: number;
  toolArtifactIds: string[];
  visualAssetIds: string[];
  visualAssetManifestIds: string[];
  browserCaptureCount: number;
  browserCaptureIds: string[];
  browserCaptureHosts: string[];
  screenshotEvidenceCount: number;
  screenshotEvidenceIds: string[];
  chartRenderCount: number;
  chartRenderIds: string[];
  browserToolVerified: boolean;
  historyRereadVerified: true;
  evidenceCount: number;
  provider: string;
  requestedModel: string;
  actualModel: string;
  coreTool: string;
  reportSealed: boolean;
  synthesisCallCount: number;
  machineEvidence?: unknown;
};

type RealSmokeRunner = (input: {
  fixturePath: string;
  profiles: string[];
  scenarioId: string;
}) => Promise<SmokeReceipt[]>;

async function runConfiguredRealSmokes(run: RealSmokeRunner): Promise<SmokeReceipt[]> {
  const receipts: SmokeReceipt[] = [];
  for (const { profile, scenarioId } of realSmokeScenarios) {
    receipts.push(...await run({
      fixturePath: join(
        process.cwd(),
        profile === 'research_synthesis'
          ? 'tests/fixtures/research-synthesis-real-smoke.json'
          : profile === 'industry_market_analysis'
            ? 'tests/fixtures/industry-real-smoke.json'
            : 'tests/fixtures/current-semantic-gold.json',
      ),
      profiles: [profile],
      scenarioId,
    }));
  }
  return receipts;
}

function visualSmokeSnapshot() {
  return {
    plan: { capability_gaps: [] },
    steps: [
      {
        stepNo: 1,
        actorType: 'tool',
        actorId: 'tavily-web-search',
        state: 'succeeded',
        outputArtifactId: 'tool-tavily',
        toolProvenance: { executionMode: 'real', implementationId: 'tavily-rest-v1' },
      },
      {
        stepNo: 2,
        actorType: 'tool',
        actorId: 'playwright-page-capture',
        state: 'succeeded',
        outputArtifactId: 'tool-browser',
        toolProvenance: {
          executionMode: 'real',
          implementationId: 'playwright-page-capture-v1',
          gapSummary: {
            count: 1,
            keys: ['3:access_blocked'],
            failuresHash: `sha256:${'a'.repeat(64)}`,
          },
        },
      },
    ],
    delivered: {
      evidenceManifest: {
        entries: [
          { id: 'E1', kind: 'tool_output', artifactId: 'tool-tavily' },
          { id: 'BC2-0', kind: 'screenshot', artifactId: 'manifest-jd' },
          { id: 'BC2-1', kind: 'screenshot', artifactId: 'manifest-tmall' },
          { id: 'BC2-2', kind: 'screenshot', artifactId: 'manifest-douyin' },
        ],
      },
      visualAssetManifests: [
        { assetId: 'asset-jd', source: { kind: 'browser_capture', sourcePageUrl: 'https://jd.com/ai' } },
        { assetId: 'asset-tmall', source: { kind: 'browser_capture', sourcePageUrl: 'https://tmall.com/ai' } },
        { assetId: 'asset-douyin', source: { kind: 'browser_capture', sourcePageUrl: 'https://douyin.com/ai' } },
        { assetId: 'asset-chart', source: { kind: 'chart_render' } },
      ],
      reportDocument: {
        sections: [{
          blocks: [
            { type: 'image', assetRef: { assetId: 'asset-jd', manifestArtifactId: 'manifest-jd' } },
            { type: 'image', assetRef: { assetId: 'asset-tmall', manifestArtifactId: 'manifest-tmall' } },
            { type: 'image', assetRef: { assetId: 'asset-douyin', manifestArtifactId: 'manifest-douyin' } },
            {
              type: 'chart',
              chartRef: { assetId: 'asset-chart', manifestArtifactId: 'manifest-chart', chartId: 'weights' },
            },
          ],
        }],
      },
    },
  };
}

test('Gold forbid approval mode rejects approval steps before confirmation and never auto-approves', () => {
  assert.equal(resolveApprovalMode(undefined), 'allow_owner');
  assert.equal(mayAutoApproveSmoke(undefined), true);
  assert.equal(resolveApprovalMode('forbid'), 'forbid');
  assert.equal(mayAutoApproveSmoke('forbid'), false);
  assert.doesNotThrow(() => assertSmokePlanApprovalPolicy([
    { actor_type: 'skill', actor_id: 'competitive-analysis', requires_approval: false },
  ], 'forbid'));
  assert.throws(() => assertSmokePlanApprovalPolicy([
    { actor_type: 'skill', actor_id: 'competitive-analysis', requires_approval: true },
  ], 'forbid'), /GOLD_APPROVAL_GATE/u);
  assert.doesNotThrow(() => assertSmokePlanApprovalPolicy([
    { actor_type: 'skill', actor_id: 'competitive-analysis', requires_approval: true },
  ]));
});

test('ordinary smoke keeps owner approval by default while Gold forbid mode rejects remaining gates', () => {
  assert.equal(mayAutoApproveSmoke(), true);
  assert.equal(mayAutoApproveSmoke('allow_owner'), true);
  assert.equal(mayAutoApproveSmoke('forbid'), false);
});

test('real smoke configuration rejects mock and half-real provider modes', () => {
  const valid = {
    ALLOW_REAL_PROVIDER: '1',
    LLM_PROVIDER: 'gateway',
    TOOL_ADAPTER: 'real',
    DATABASE_URL: 'postgres://smoke.invalid/db',
    JWT_SECRET: 'test-only',
    LLM_GATEWAY_BASE_URL: 'https://gateway.invalid',
    LLM_GATEWAY_API_KEY: 'test-only',
    LLM_MODEL_NAME: 'route-a',
    LLM_EXPECTED_ACTUAL_MODEL: 'model-a',
    TAVILY_API_KEY: 'test-only',
  };
  assert.doesNotThrow(() => assertRealSmokeConfig(valid));
  assert.throws(() => assertRealSmokeConfig({ ...valid, ALLOW_REAL_PROVIDER: '0' }), /exactly 1/u);
  assert.throws(() => assertRealSmokeConfig({ ...valid, LLM_PROVIDER: 'mock' }), /exactly gateway/u);
  assert.throws(() => assertRealSmokeConfig({ ...valid, TOOL_ADAPTER: 'fake' }), /exactly real/u);
});

test('research synthesis smoke selects the report contract from the publication flags', () => {
  assert.deepEqual(resolveSmokeReportContract({
    deliverableType: 'research_strategy_report',
    reportV3WriterEnabled: false,
    standaloneHtmlBundleV1Enabled: false,
  }), {
    reportDocumentVersion: 'report-document-v2',
    reportPackageVersion: 'report-package-v1',
    standaloneHtmlStatus: 'not_applicable',
    showcaseStatus: 'not_applicable',
    fixedPackageRoot: false,
  });
  assert.deepEqual(resolveSmokeReportContract({
    deliverableType: 'research_strategy_report',
    reportV3WriterEnabled: true,
    standaloneHtmlBundleV1Enabled: true,
  }), {
    reportDocumentVersion: 'report-document-v3',
    reportPackageVersion: 'report-package-v2',
    standaloneHtmlStatus: 'ready',
    showcaseStatus: 'not_applicable',
    fixedPackageRoot: true,
  });
  assert.deepEqual(resolveSmokeReportContract({
    deliverableType: 'research_strategy_report',
    reportV3WriterEnabled: true,
    standaloneHtmlBundleV1Enabled: true,
    reportEditorialExperienceV1Enabled: true,
    reportEditorialShowcaseV1Enabled: true,
  }), {
    reportDocumentVersion: 'report-document-v4',
    reportPackageVersion: 'report-package-v3',
    standaloneHtmlStatus: 'ready',
    showcaseStatus: 'ready',
    fixedPackageRoot: true,
  });
  assert.deepEqual(resolveSmokeReportContract({
    deliverableType: 'competitive_analysis_report',
    reportV3WriterEnabled: true,
    standaloneHtmlBundleV1Enabled: true,
  }), {
    reportPackageVersion: 'report-package-v1',
    standaloneHtmlStatus: 'not_applicable',
    showcaseStatus: 'not_applicable',
    fixedPackageRoot: false,
  });
});

function validVirtualUserSimulationResponse(): Record<string, unknown> {
  return {
    status: 'available',
    isSimulated: true,
    summary: 'Synthetic readiness probe completed.',
    digitalPersonas: [{
      id: 'persona-1',
      name: 'Readiness probe persona',
      type: 'synthetic evaluator',
      description: 'A synthetic persona used only to verify service readiness.',
      goals: ['Evaluate the supplied scenario.'],
      concerns: ['Simulation output is not real user evidence.'],
    }],
    reviews: [{
      profileId: 'persona-1',
      personaName: 'Readiness probe persona',
      personaType: 'synthetic evaluator',
      firstImpression: 'The scenario can be evaluated.',
      detailedExperience: 'The service returned a complete synthetic review.',
      scores: { usability: 0.8 },
      overallScore: 0.8,
      topChangeRequest: 'Keep the synthetic-evidence boundary explicit.',
      stance: 'positive',
      isSimulated: true,
    }],
    aggregate: {
      scoreSummary: { usability: 0.8 },
      sharedPainPoints: [],
      sharedHighlights: ['The simulation contract is available.'],
      divergences: [],
      churnRisks: [],
    },
    recommendations: ['Use the result only as a synthetic hypothesis.'],
    warnings: ['This is not real user research.'],
    boundaryNotes: ['No factual user conclusion may be drawn from this probe.'],
  };
}

test('virtual-user-lab preflight checks both liveness and the simulation contract', async () => {
  const calls: string[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.endsWith('/api/health')) {
      return Response.json({ ok: true, service: 'virtual-user-lab' });
    }
    return Response.json(validVirtualUserSimulationResponse());
  };

  await assertVirtualUserLabReady('http://127.0.0.1:8804/', fakeFetch);
  assert.deepEqual(calls, [
    'GET http://127.0.0.1:8804/api/health',
    'POST http://127.0.0.1:8804/api/simulate',
  ]);
});

test('virtual-user-lab preflight rejects output that only satisfies the legacy shallow checks', async () => {
  await assert.rejects(
    () => assertVirtualUserLabReady('http://127.0.0.1:8804', async (input) => (
      String(input).endsWith('/api/health')
        ? Response.json({ ok: true, service: 'virtual-user-lab' })
        : Response.json({ status: 'available', isSimulated: true, reviews: [{ profileId: 'test' }] })
    )),
    (error: unknown) => error instanceof SmokeInfrastructureError
      && error.message === 'virtual-user-lab preflight failed',
  );
});

test('virtual-user-lab preflight classifies unreachable or degraded service as infrastructure failure', async () => {
  await assert.rejects(
    () => assertVirtualUserLabReady('http://127.0.0.1:8804', async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:8804');
    }),
    (error: unknown) => error instanceof Error
      && error.name === 'SmokeInfrastructureError'
      && error.message === 'virtual-user-lab preflight failed',
  );
  await assert.rejects(
    () => assertVirtualUserLabReady('http://127.0.0.1:8804', async (input) => (
      String(input).endsWith('/api/health')
        ? Response.json({ ok: true, service: 'virtual-user-lab' })
        : Response.json({
            ...validVirtualUserSimulationResponse(),
            status: 'insufficient_inputs',
            digitalPersonas: [],
            reviews: [],
          })
    )),
    /virtual-user-lab simulation preflight failed/u,
  );
});

test('formatted receipt rejects non-real or non-Tavily Tool proof', () => {
  const snapshot = visualSmokeSnapshot();
  const summary = verifySmokeHistoryReread({
    executionGapCount: 1,
    initial: summarizeSmokeEvidence(snapshot),
    reread: summarizeSmokeEvidence(snapshot),
    requireBrowserEvidence: true,
  });
  const base = {
    ...summary,
    scenarioId: 'competitive-ai-shopping-assistant',
    profile: 'competitive_research',
    taskType: 'competitive_research',
    deliverableType: 'competitive_analysis_report',
    taskId: 'task-1',
    planVersionId: 'plan-1',
    attemptId: 'attempt-1',
    reportPackageId: 'package-1',
    visualAssetCount: 4,
    deliverableArtifactId: 'deliverable-1',
    evidenceManifestArtifactId: 'evidence-manifest-1',
    evidenceArtifactIds: ['evidence-1'],
    counts: { evidence: 3, findings: 1, recommendations: 1 },
    sources: ['https://one.test', 'https://two.test', 'https://three.test'],
    provider: 'gateway',
    requestedModel: 'route-a',
    actualModel: 'model-a',
    coreTool: 'tavily-web-search',
    packageSealed: true,
    review: { artifactId: 'review-1', automated: true as const, verdict: 'pass' as const },
  };
  for (const toolReceipt of [
    { actorId: 'tavily-web-search', declaredAdapterType: 'tavily', resolvedAdapterType: 'tavily', implementationId: 'tavily-rest-v1', executionMode: 'mock', endpointHost: 'api.tavily.com', status: 'ok', latencyMs: 1 },
    { actorId: 'tavily-web-search', declaredAdapterType: 'fake', resolvedAdapterType: 'tavily', implementationId: 'tavily-rest-v1', executionMode: 'real', endpointHost: 'api.tavily.com', status: 'ok', latencyMs: 1 },
  ]) {
    assert.throws(() => formatSmokeReceipt({ ...base, toolReceipt }), /real Tavily/u);
  }
});

test('real smoke retries an isolated Editorial Summary failure at most once', async () => {
  let calls = 0;
  const result = await readEditorialSummaryWithOneRetry(async () => {
    calls += 1;
    if (calls === 1) throw new Error('transient summary failure');
    return '<!doctype html><html lang="zh-CN"></html>';
  });
  assert.match(result ?? '', /^<!doctype html>/u);
  assert.equal(calls, 2);

  calls = 0;
  await assert.rejects(() => readEditorialSummaryWithOneRetry(async () => {
    calls += 1;
    throw new Error('persistent summary failure');
  }), /persistent summary failure/u);
  assert.equal(calls, 2);

  const explicitFailure = await verifyEditorialSummaryForSmoke(async () => {
    throw new Error('persistent summary failure');
  });
  assert.equal(explicitFailure.status, 'failed');
  assert.match(explicitFailure.failure ?? '', /^Current real smoke failed error_type=Error message_hash=[a-f0-9]{16}$/u);
});

test('current real smoke covers all seven Current profiles', () => {
  assert.deepEqual(realProfiles, [
    'competitive_research',
    'user_research_planning',
    'research_synthesis',
    'voc_diagnosis',
    'design_audit',
    'a11y_audit',
    'industry_market_analysis',
  ]);
});

test('smoke plan coverage treats report drafting and review as engine-owned stages', () => {
  assert.doesNotThrow(() => requireActorCoverage([
    {
      actorType: 'tool',
      actorId: 'tavily-web-search',
      state: 'succeeded',
    },
    {
      actorType: 'tool',
      actorId: 'playwright-page-capture',
      state: 'succeeded',
    },
    {
      actorType: 'skill',
      actorId: 'competitive-web-research',
      state: 'succeeded',
    },
  ], [
    { actor_type: 'tool', actor_id: 'tavily-web-search' },
    { actor_type: 'tool', actor_id: 'playwright-page-capture' },
    { actor_type: 'skill', actor_id: 'competitive-web-research' },
  ]));
});

test('real smoke selects one exact scenario and rejects missing or mismatched ids', () => {
  const fixture = {
    profiles: ['competitive_research', 'voc_diagnosis'],
    scenarios: [
      {
        id: 'competitive-ai-shopping-assistant',
        profile: 'competitive_research',
        taskType: 'competitive_research',
        businessDomain: 'ecommerce_ai_shopping',
        input: 'fixed competitive input',
        expectedDeliverableType: 'competitive_analysis_report',
        minPublicSources: 3,
        minVisualAssets: 0,
        sensitivity: 'public',
        piiDetected: false,
        variant: 'clear',
      },
    ],
  } as const;

  assert.equal(
    selectSmokeScenario(fixture, 'competitive_research', 'competitive-ai-shopping-assistant').id,
    'competitive-ai-shopping-assistant',
  );
  assert.throws(
    () => selectSmokeScenario(fixture, 'competitive_research', ''),
    /scenarioId.*required/u,
  );
  assert.throws(
    () => selectSmokeScenario(fixture, 'competitive_research', 'missing-scenario'),
    /missing-scenario.*not found/u,
  );
  assert.throws(
    () => selectSmokeScenario(fixture, 'voc_diagnosis', 'competitive-ai-shopping-assistant'),
    /does not match profile voc_diagnosis/u,
  );
});

test('runCurrentRealSmoke fails closed on a missing, unknown, or profile-mismatched scenarioId', async () => {
  const fixturePath = join(process.cwd(), 'tests/fixtures/current-semantic-gold.json');
  await assert.rejects(
    () => runCurrentRealSmoke({ fixturePath, profiles: ['competitive_research'] } as never),
    /scenarioId.*required/u,
  );
  await assert.rejects(
    () => runCurrentRealSmoke({
      fixturePath,
      profiles: ['competitive_research'],
      scenarioId: 'missing-scenario',
    }),
    /missing-scenario.*not found/u,
  );
  await assert.rejects(
    () => runCurrentRealSmoke({
      fixturePath,
      profiles: ['voc_diagnosis'],
      scenarioId: 'competitive-ai-shopping-assistant',
    }),
    /does not match profile voc_diagnosis/u,
  );
});

test('protected browser evidence cannot be required while Playwright capture is disabled', async () => {
  const priorRequired = process.env.CURRENT_REQUIRE_BROWSER_EVIDENCE;
  const priorCapture = process.env.PLAYWRIGHT_CAPTURE_ENABLED;
  process.env.CURRENT_REQUIRE_BROWSER_EVIDENCE = '1';
  process.env.PLAYWRIGHT_CAPTURE_ENABLED = '0';
  try {
    await assert.rejects(() => runCurrentRealSmoke({
      fixturePath: join(process.cwd(), 'tests/fixtures/current-semantic-gold.json'),
      profiles: ['competitive_research'],
      scenarioId: 'competitive-ai-shopping-assistant',
    }), /required browser evidence needs PLAYWRIGHT_CAPTURE_ENABLED=1/u);
  } finally {
    if (priorRequired === undefined) delete process.env.CURRENT_REQUIRE_BROWSER_EVIDENCE;
    else process.env.CURRENT_REQUIRE_BROWSER_EVIDENCE = priorRequired;
    if (priorCapture === undefined) delete process.env.PLAYWRIGHT_CAPTURE_ENABLED;
    else process.env.PLAYWRIGHT_CAPTURE_ENABLED = priorCapture;
  }
});

test('visual smoke receipt preserves evidence ids and verifies the historical reread', () => {
  const initial = summarizeSmokeEvidence(visualSmokeSnapshot());
  const verified = verifySmokeHistoryReread({
    executionGapCount: 1,
    initial,
    reread: summarizeSmokeEvidence(visualSmokeSnapshot()),
    requireBrowserEvidence: true,
  });

  assert.deepEqual(verified, {
    gapCount: 1,
    toolArtifactIds: ['tool-browser', 'tool-tavily'],
    visualAssetIds: ['asset-chart', 'asset-douyin', 'asset-jd', 'asset-tmall'],
    visualAssetManifestIds: ['manifest-chart', 'manifest-douyin', 'manifest-jd', 'manifest-tmall'],
    browserCaptureCount: 3,
    browserCaptureIds: ['asset-douyin', 'asset-jd', 'asset-tmall'],
    browserCaptureHosts: ['douyin.com', 'jd.com', 'tmall.com'],
    screenshotEvidenceCount: 3,
    screenshotEvidenceIds: ['BC2-0', 'BC2-1', 'BC2-2'],
    chartRenderCount: 1,
    chartRenderIds: ['asset-chart'],
    browserToolVerified: true,
    historyRereadVerified: true,
  });
});

test('formatted smoke receipt exposes the scenario and all audited visual counters', () => {
  const summary = summarizeSmokeEvidence(visualSmokeSnapshot());
  const evidence = verifySmokeHistoryReread({
    executionGapCount: 1,
    initial: summary,
    reread: summary,
    requireBrowserEvidence: true,
  });
  const receipt = formatSmokeReceipt({
    ...evidence,
    scenarioId: 'competitive-ai-shopping-assistant',
    profile: 'competitive_research',
    taskType: 'competitive_research',
    deliverableType: 'competitive_analysis_report',
    taskId: 'task-1',
    planVersionId: 'plan-1',
    attemptId: 'attempt-1',
    reportPackageId: 'package-1',
    visualAssetCount: 4,
    deliverableArtifactId: 'deliverable-1',
    evidenceManifestArtifactId: 'evidence-manifest-1',
    evidenceArtifactIds: ['evidence-1'],
    toolReceipt: {
      actorId: 'tavily-web-search',
      declaredAdapterType: 'tavily',
      resolvedAdapterType: 'tavily',
      implementationId: 'tavily-rest-v1',
      executionMode: 'real',
      endpointHost: 'api.tavily.com',
      status: 'ok',
      latencyMs: 1,
    },
    counts: { evidence: 3, findings: 1, recommendations: 1 },
    sources: ['https://example.test/one', 'https://example.test/two', 'https://example.test/three'],
    provider: 'gateway',
    requestedModel: 'route-a',
    actualModel: 'model-a',
    coreTool: 'tavily-web-search',
    packageSealed: true,
    review: { artifactId: 'review-1', automated: true, verdict: 'pass' },
  });

  assert.equal(receipt.scenarioId, 'competitive-ai-shopping-assistant');
  assert.equal(receipt.gapCount, 1);
  assert.equal(receipt.browserCaptureCount, 3);
  assert.equal(receipt.screenshotEvidenceCount, 3);
  assert.equal(receipt.chartRenderCount, 1);
  assert.equal(receipt.historyRereadVerified, true);
  assert.throws(
    () => formatSmokeReceipt({ ...receipt, browserCaptureCount: 2 }),
    /evidence counts or historical verification are invalid/u,
  );
});

test('browser evidence is optional by default and mandatory only for the protected visual smoke', () => {
  const textOnly = summarizeSmokeEvidence({
    plan: { capability_gaps: [] },
    steps: [{
      stepNo: 1,
      actorType: 'tool',
      actorId: 'tavily-web-search',
      state: 'succeeded',
      outputArtifactId: 'tool-tavily',
      toolProvenance: { executionMode: 'real', implementationId: 'tavily-rest-v1' },
    }],
    delivered: { evidenceManifest: { entries: [] } },
  });

  assert.equal(verifySmokeHistoryReread({
    executionGapCount: 0,
    initial: textOnly,
    reread: textOnly,
    requireBrowserEvidence: false,
  }).browserCaptureCount, 0);
  assert.throws(() => verifySmokeHistoryReread({
    executionGapCount: 0,
    initial: textOnly,
    reread: textOnly,
    requireBrowserEvidence: true,
  }), /required browser or chart evidence is missing/u);
});

test('real smoke reconstructs one degraded Skill Gap from persisted Skill provenance', () => {
  const steps = [{
    stepNo: 2,
    actorType: 'skill',
    actorId: 'competitive-web-research',
    state: 'succeeded',
    outputArtifactId: 'skill-output-2',
    toolProvenance: null,
    skillProvenance: {
      status: 'degraded',
      limitations: ['public evidence is insufficient'],
    },
  }] as unknown as Parameters<typeof summarizeSmokeEvidence>[0]['steps'];

  const evidence = summarizeSmokeEvidence({
    plan: { capability_gaps: [] },
    steps,
    delivered: { evidenceManifest: { entries: [] } },
  });

  assert.equal(evidence.gapCount, 1);
});

test('real smoke reconstructs a frozen Skill resource Gap from the Plan', () => {
  const evidence = summarizeSmokeEvidence({
    plan: {
      capability_gaps: [],
      skill_invocations: [{
        invocation_id: 'research-strategy-synthesis:2',
        skill_id: 'research-strategy-synthesis',
        execution_mode: 'compiled',
        resource_gaps: [{
          query_id: 'recent-public-evidence',
          min_items: 2,
          selected_items: 1,
          failure_policy: 'gap',
          reason: 'only one current source is available',
        }],
        step_nos: [2],
      }],
    },
    steps: [],
    delivered: { evidenceManifest: { entries: [] } },
  });

  assert.equal(evidence.gapCount, 1);
});

test('real smoke counts every degraded Skill once and composes Skill, resource, and Tool Gaps', () => {
  const degradedSteps = [
    {
      stepNo: 2,
      actorType: 'skill',
      actorId: 'competitive-web-research',
      state: 'succeeded',
      skillProvenance: { status: 'degraded', limitations: ['insufficient evidence'] },
    },
    {
      stepNo: 3,
      actorType: 'skill',
      actorId: 'research-strategy-synthesis',
      state: 'succeeded',
      skillProvenance: { status: 'degraded', limitations: ['unverified assumptions'] },
    },
    {
      stepNo: 4,
      actorType: 'tool',
      actorId: 'optional-tool',
      state: 'skipped',
      toolProvenance: null,
    },
  ] as unknown as Parameters<typeof summarizeSmokeEvidence>[0]['steps'];
  const evidence = summarizeSmokeEvidence({
    plan: {
      capability_gaps: [],
      skill_invocations: [{
        invocation_id: 'research-strategy-synthesis:3',
        skill_id: 'research-strategy-synthesis',
        execution_mode: 'compiled',
        resource_gaps: [{
          query_id: 'recent-public-evidence',
          min_items: 2,
          selected_items: 1,
          failure_policy: 'gap',
          reason: 'only one source is available',
        }],
        step_nos: [3],
      }],
    },
    steps: degradedSteps,
    delivered: { evidenceManifest: { entries: [] } },
  });

  assert.equal(evidence.gapCount, 4);

  const succeededSteps = [{
    ...degradedSteps[0],
    skillProvenance: { status: 'succeeded', limitations: [] },
  }] as unknown as Parameters<typeof summarizeSmokeEvidence>[0]['steps'];
  assert.equal(summarizeSmokeEvidence({
    plan: { capability_gaps: [] },
    steps: succeededSteps,
    delivered: { evidenceManifest: { entries: [] } },
  }).gapCount, 0);
});

test('real smoke fails closed on an unknown persisted Skill status', () => {
  const steps = [{
    stepNo: 2,
    actorType: 'skill',
    actorId: 'competitive-web-research',
    state: 'succeeded',
    skillProvenance: { status: 'partial' },
  }] as unknown as Parameters<typeof summarizeSmokeEvidence>[0]['steps'];

  assert.throws(() => summarizeSmokeEvidence({
    plan: { capability_gaps: [] },
    steps,
    delivered: { evidenceManifest: { entries: [] } },
  }), /skillProvenance\.status is invalid/u);
});

test('visual smoke keeps the legacy skipped-Tool gap fallback', () => {
  const evidence = summarizeSmokeEvidence({
    plan: { capability_gaps: [] },
    steps: [
      {
        stepNo: 1,
        actorType: 'tool',
        actorId: 'tavily-web-search',
        state: 'succeeded',
        outputArtifactId: 'tool-tavily',
        toolProvenance: { executionMode: 'real', implementationId: 'tavily-rest-v1' },
      },
      {
        stepNo: 2,
        actorType: 'tool',
        actorId: 'legacy-optional-tool',
        state: 'skipped',
        toolProvenance: null,
      },
    ],
    delivered: { evidenceManifest: { entries: [] } },
  });

  assert.equal(evidence.gapCount, 1);
});

test('visual smoke rejects historical count or id drift', () => {
  const initial = summarizeSmokeEvidence(visualSmokeSnapshot());
  assert.throws(() => verifySmokeHistoryReread({
    executionGapCount: 1,
    initial,
    reread: { ...initial, screenshotEvidenceIds: ['drifted-evidence-id'] },
    requireBrowserEvidence: true,
  }), /historical reread counts or ids drifted/u);
  assert.throws(() => verifySmokeHistoryReread({
    executionGapCount: 2,
    initial,
    reread: initial,
    requireBrowserEvidence: true,
  }), /gapCount.*execution receipt/u);
});

test('visual smoke rejects gapSummary URL or message leakage', () => {
  for (const leaked of [
    { requestedUrl: 'https://private.example/path' },
    { message: 'upstream body must not be copied' },
  ]) {
    const snapshot = visualSmokeSnapshot();
    Object.assign(snapshot.steps[1]!.toolProvenance!.gapSummary!, leaked);
    assert.throws(
      () => summarizeSmokeEvidence(snapshot),
      /gapSummary.*(?:only|leaks)/u,
    );
  }
});

test('visual smoke rejects mixed or malformed gapSummary keys', () => {
  const baseSummary = visualSmokeSnapshot().steps[1]!.toolProvenance!.gapSummary!;
  for (const gapSummary of [
    { ...baseSummary, count: 2, keys: ['3:access_blocked', 'step:configuration'] },
    { ...baseSummary, count: 2, keys: ['step:configuration', 'step:capacity'] },
    { ...baseSummary, count: 0, keys: [] },
    { ...baseSummary, keys: ['03:access_blocked'] },
    { ...baseSummary, keys: ['3:AccessBlocked'] },
    { ...baseSummary, keys: ['https://private.example/path'] },
  ]) {
    const snapshot = visualSmokeSnapshot();
    snapshot.steps[1]!.toolProvenance!.gapSummary = gapSummary;
    assert.throws(
      () => summarizeSmokeEvidence(snapshot),
      /gapSummary.*(?:count|malformed|mix)/u,
    );
  }
});

test('visual smoke verifies gapSummary against the sealed failure truth source', () => {
  const failures = [{
    source_result_index: 3,
    requested_url: 'https://public.example/product',
    code: 'access_blocked',
    sanitized_message: 'page blocked access',
  }];
  const stableFailures = [{
    code: 'access_blocked',
    requested_url: 'https://public.example/product',
    sanitized_message: 'page blocked access',
    source_result_index: 3,
  }];
  const expectedHash = `sha256:${createHash('sha256')
    .update(JSON.stringify(stableFailures))
    .digest('hex')}`;
  const snapshot = visualSmokeSnapshot();
  snapshot.steps[1]!.toolProvenance!.gapSummary!.failuresHash = expectedHash;

  assert.doesNotThrow(() => verifySmokeGapSummaryHashes({
    steps: snapshot.steps,
    toolOutputsByArtifactId: { 'tool-browser': { output: { failures } } },
  }));
  const skippedStep = {
    ...snapshot.steps[1]!,
    state: 'skipped',
    outputArtifactId: null,
    failure: { page_failures: failures },
  };
  assert.doesNotThrow(() => verifySmokeGapSummaryHashes({
    steps: [skippedStep],
    toolOutputsByArtifactId: {},
  }));

  const persistedFailure = {
    allowedActions: [],
    kind: 'configuration',
    message: 'browser capture is disabled',
    retryable: false,
    toolTier: 'optional',
  };
  const expectedStepHash = `sha256:${createHash('sha256')
    .update(JSON.stringify(persistedFailure))
    .digest('hex')}`;
  const skippedConfigurationStep = {
    ...snapshot.steps[1]!,
    state: 'skipped',
    outputArtifactId: null,
    failure: persistedFailure,
    toolProvenance: {
      ...snapshot.steps[1]!.toolProvenance!,
      gapSummary: {
        count: 1,
        keys: ['step:configuration'],
        failuresHash: expectedStepHash,
      },
    },
  };
  assert.doesNotThrow(() => verifySmokeGapSummaryHashes({
    steps: [skippedConfigurationStep],
    toolOutputsByArtifactId: {},
  }));
  assert.throws(() => verifySmokeGapSummaryHashes({
    steps: [{
      ...skippedConfigurationStep,
      failure: { ...persistedFailure, allowedActions: ['retry'] },
    }],
    toolOutputsByArtifactId: {},
  }), /failuresHash.*truth source/u, 'step summaries hash the complete persisted failure');
  assert.throws(() => verifySmokeGapSummaryHashes({
    steps: [{ ...skippedConfigurationStep, state: 'succeeded' }],
    toolOutputsByArtifactId: {},
  }), /step gapSummary.*not allowed/u);

  snapshot.steps[1]!.toolProvenance!.gapSummary!.failuresHash = `sha256:${'b'.repeat(64)}`;
  assert.throws(() => verifySmokeGapSummaryHashes({
    steps: snapshot.steps,
    toolOutputsByArtifactId: { 'tool-browser': { output: { failures } } },
  }), /failuresHash.*truth source/u);
});

test('design smoke accepts one explicit absolute local image path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'current-design-smoke-'));
  try {
    const path = join(dir, 'design.png');
    writeFileSync(path, Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ));
    const value = designSmokeInputValue(path);
    assert.match(value.dataUrl, /^data:image\/png;base64,/u);
    assert.doesNotMatch(value.dataUrl, new RegExp(path, 'u'));
    assert.throws(() => designSmokeInputValue('relative.png'), /absolute local path/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('gateway model receipts support a routing alias with a distinct canonical actual model', () => {
  assert.doesNotThrow(() => assertGatewayModelReceipts({
    modelRoutes: [{ requestedModel: 'gateway-routing-alias', expectedActualModel: 'canonical-model-id' }],
    modelCalls: [{
      status: 'succeeded',
      provider: 'gateway',
      requestedModel: 'gateway-routing-alias',
      actualModel: 'canonical-model-id',
    }],
  }));
});

test('gateway model receipts still reject actual model drift', () => {
  assert.throws(() => assertGatewayModelReceipts({
    modelRoutes: [{ requestedModel: 'gateway-routing-alias', expectedActualModel: 'canonical-model-id' }],
    modelCalls: [{
      status: 'succeeded',
      provider: 'gateway',
      requestedModel: 'gateway-routing-alias',
      actualModel: 'unexpected-model-id',
    }],
  }), /invalid gateway model receipt/);
});

test('gateway model receipts validate every configured route independently', () => {
  assert.doesNotThrow(() => assertGatewayModelReceipts({
    modelRoutes: [
      { requestedModel: 'route-a', expectedActualModel: 'model-a' },
      { requestedModel: 'route-b', expectedActualModel: 'model-b' },
    ],
    modelCalls: [
      { status: 'succeeded', provider: 'gateway', requestedModel: 'route-a', actualModel: 'model-a' },
      { status: 'succeeded', provider: 'gateway', requestedModel: 'route-b', actualModel: 'model-b' },
    ],
  }));
  assert.throws(() => assertGatewayModelReceipts({
    modelRoutes: [
      { requestedModel: 'route-a', expectedActualModel: 'model-a' },
      { requestedModel: 'route-b', expectedActualModel: 'model-b' },
    ],
    modelCalls: [
      { status: 'succeeded', provider: 'gateway', requestedModel: 'route-b', actualModel: 'model-a' },
    ],
  }), /invalid gateway model receipt/);
});

test('real smoke CLI failures expose only a stable message hash', () => {
  const credential = 'postgres://operator:secret-value@localhost:5432/smoke';
  const message = safeSmokeErrorMessage(new Error(`connection failed: ${credential}`));
  assert.match(message, /^Current real smoke failed error_type=Error message_hash=[a-f0-9]{16}$/u);
  assert.doesNotMatch(message, /operator|secret-value|postgres:/u);
  assert.equal(message, safeSmokeErrorMessage(new Error(`connection failed: ${credential}`)));
});

test('real smoke enforces semantic Gold evidence and visual minimums in the CLI path', () => {
  assert.doesNotThrow(() => assertSmokeReceiptMinimums({
    evidenceCount: 3,
    visualAssetCount: 0,
    sources: ['https://one.test', 'https://two.test', 'https://three.test'],
  }, { minPublicSources: 3, minVisualAssets: 0 }));
  assert.throws(() => assertSmokeReceiptMinimums({
    evidenceCount: 2,
    visualAssetCount: 0,
    sources: ['https://one.test', 'https://two.test'],
  }, { minPublicSources: 3, minVisualAssets: 0 }), /evidence.*minimum/i);
  assert.throws(() => assertSmokeReceiptMinimums({
    evidenceCount: 3,
    visualAssetCount: 0,
    sources: ['https://one.test', 'https://ONE.test/', 'https://one.test/#same-source'],
  }, { minPublicSources: 3, minVisualAssets: 0 }), /evidence.*minimum/i);
  assert.throws(() => assertSmokeReceiptMinimums({
    evidenceCount: 3,
    visualAssetCount: 0,
    sources: [
      'https://example.test/path',
      'https://example.test./%70ath',
      'https://EXAMPLE.test/pa%74h#same-source',
    ],
  }, { minPublicSources: 3, minVisualAssets: 0 }), /evidence.*minimum/i);
  assert.throws(() => assertSmokeReceiptMinimums({
    evidenceCount: 3,
    visualAssetCount: 1,
    sources: ['https://one.test', 'https://two.test', 'https://three.test'],
  }, { minPublicSources: 3, minVisualAssets: 2 }), /visual.*minimum/i);
});

test('real smoke accepts a profile-specific Skill instead of one global Skill pair', () => {
  const selected = selectSmokeCandidate([
    {
      candidateId: 'depth',
      plan: {
        steps: [
          { actor_type: 'tool', actor_id: 'tavily-web-search' },
          { actor_type: 'skill', actor_id: 'competitive-web-research' },
          { actor_type: 'llm', actor_id: 'current-llm' },
          { actor_type: 'reviewer', actor_id: 'research-lead-reviewer' },
        ],
      },
    },
    {
      candidateId: 'speed',
      plan: {
        steps: [
          { actor_type: 'tool', actor_id: 'tavily-web-search' },
          { actor_type: 'skill', actor_id: 'competitive-web-research' },
          { actor_type: 'llm', actor_id: 'current-llm' },
        ],
      },
    },
  ]);

  assert.equal(selected.candidateId, 'speed');
});

test('real smoke continues clarification until the requirement becomes ready', async () => {
  const answers: Array<Record<string, unknown>> = [];
  const result = await resolveSmokeRequirement({
    status: 'clarification_required',
    requirement: { clarification_questions: [{ key: 'scope', question: 'Which scope?' }] },
  }, async (roundAnswers) => {
    answers.push(roundAnswers);
    if (answers.length === 1) {
      return {
        status: 'clarification_required',
        requirement: { clarification_questions: [{ key: 'audience', question: 'Which audience?' }] },
      };
    }
    return {
      status: 'ready_to_plan',
      requirement: { clarification_questions: [] },
      planningResult: { id: 'plan' },
    };
  });

  assert.equal(result.status, 'ready_to_plan');
  assert.equal(answers.length, 2);
  assert.match(String(answers[0]?.scope), /^Controlled smoke decision:/);
});

test('real smoke finalizes a direction gate with no remaining requirement questions', async () => {
  const answers: Array<Record<string, unknown>> = [];
  const selectedScenarios: Array<string | undefined> = [];
  const result = await resolveSmokeRequirement({
    status: 'clarification_required',
    requirement: { clarification_questions: [] },
    planningGuidance: { options: [{ id: 'strategy-synthesis' }] },
  }, async (roundAnswers, selectedScenarioId) => {
    answers.push(roundAnswers);
    selectedScenarios.push(selectedScenarioId);
    return {
      status: 'ready_to_plan',
      requirement: { clarification_questions: [] },
      planningResult: { id: 'plan' },
    };
  }, 'strategy-synthesis');
  assert.equal(result.status, 'ready_to_plan');
  assert.deepEqual(answers, [{}]);
  assert.deepEqual(selectedScenarios, ['strategy-synthesis']);
});

test('real smoke bounds clarification to three rounds', async () => {
  let rounds = 0;
  const result = await resolveSmokeRequirement({
    status: 'clarification_required',
    requirement: { clarification_questions: [{ key: 'scope', question: 'Which scope?' }] },
  }, async () => {
    rounds += 1;
    return {
      status: 'clarification_required',
      requirement: { clarification_questions: [{ key: 'scope', question: 'Which scope?' }] },
    };
  });

  assert.equal(result.status, 'clarification_required');
  assert.equal(rounds, 3);
});

test('current real smoke produces one receipt for each supported full-real profile', realSmokeOptions, async () => {
  const smoke = await import('../scripts/current-real-smoke.ts') as {
    runCurrentRealSmoke: RealSmokeRunner;
  };
  const receipts = await runConfiguredRealSmokes(smoke.runCurrentRealSmoke);

  assert.equal(receipts.length, realProfiles.length);
  assert.deepEqual(receipts.map((receipt) => receipt.profile), realProfiles);
  assert.deepEqual(
    receipts.map((receipt) => receipt.scenarioId),
    realSmokeScenarios.map(({ scenarioId }) => scenarioId),
  );
});

test('current real smoke receipts preserve task, plan, attempt, NativeFinalReport, and NativeSkillResult identity', realSmokeOptions, async () => {
  const smoke = await import('../scripts/current-real-smoke.ts') as {
    runCurrentRealSmoke: RealSmokeRunner;
  };
  const receipts = await runConfiguredRealSmokes(smoke.runCurrentRealSmoke);

  for (const key of ['taskId', 'planVersionId', 'attemptId', 'finalReportArtifactId'] as const) {
    const values = receipts.map((receipt) => receipt[key]);
    assert.ok(values.every((value) => value.trim().length > 0), `${key} must be present`);
    assert.equal(new Set(values).size, receipts.length, `${key} must be unique per profile`);
  }
});

test('current real smoke reports visual and evidence counts for every profile', realSmokeOptions, async () => {
  const smoke = await import('../scripts/current-real-smoke.ts') as {
    runCurrentRealSmoke: RealSmokeRunner;
  };
  const receipts = await runConfiguredRealSmokes(smoke.runCurrentRealSmoke);
  const fixture = JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/current-semantic-gold.json'), 'utf8')) as {
    scenarios: Array<{
      id: string;
      profile: string;
      expectedDeliverableType: string;
      minPublicSources: number;
      minVisualAssets: number;
    }>;
  };

  for (const receipt of receipts) {
    const expected = fixture.scenarios.find((scenario) => scenario.id === receipt.scenarioId);
    assert.ok(expected, `missing fixture scenario ${receipt.scenarioId}`);
    assert.equal(expected.profile, receipt.profile);
    assert.equal(receipt.deliverableType, expected.expectedDeliverableType);
    assert.ok(receipt.evidenceCount >= expected.minPublicSources, `${receipt.profile} evidence is insufficient`);
    assert.ok(receipt.visualAssetCount >= expected.minVisualAssets, `${receipt.profile} visual count is insufficient`);
    assert.equal(receipt.visualAssetCount, receipt.visualAssetIds.length);
    assert.equal(receipt.visualAssetCount, receipt.visualAssetManifestIds.length);
    assert.equal(receipt.browserCaptureCount, receipt.browserCaptureIds.length);
    assert.equal(receipt.screenshotEvidenceCount, receipt.screenshotEvidenceIds.length);
    assert.equal(receipt.chartRenderCount, receipt.chartRenderIds.length);
    assert.equal(receipt.historyRereadVerified, true);
  }
});

test('current real smoke is full-real, model-pinned, core-tool-backed, and NativeFinalReport-sealed', realSmokeOptions, async () => {
  const smoke = await import('../scripts/current-real-smoke.ts') as {
    runCurrentRealSmoke: RealSmokeRunner;
  };
  const receipts = await runConfiguredRealSmokes(smoke.runCurrentRealSmoke);

  for (const receipt of receipts) {
    assert.equal(receipt.provider, 'gateway');
    const expectedByRequested = new Map(
      parseModelRoutes(process.env.LLM_MODEL_ROUTES, process.env.LLM_MODEL_NAME)
        .map(({ requestedModel, expectedActualModel }) => [requestedModel, expectedActualModel]),
    );
    assert.equal(receipt.actualModel, expectedByRequested.get(receipt.requestedModel));
    assert.equal(receipt.coreTool, 'tavily-web-search');
    assert.equal(receipt.contract, 'native');
    assert.equal(receipt.reportSealed, true);
    assert.ok(receipt.skillResultArtifactIds.length >= 1);
    assert.ok(receipt.synthesisCallCount === 0 || receipt.synthesisCallCount === 1);
  }
});

test('current real smoke receipts and machine evidence never expose secrets or raw inputs', realSmokeOptions, async () => {
  const smoke = await import('../scripts/current-real-smoke.ts') as {
    runCurrentRealSmoke: RealSmokeRunner;
  };
  const receipts = await runConfiguredRealSmokes(smoke.runCurrentRealSmoke);

  for (const receipt of receipts) {
    const serialized = JSON.stringify(receipt);
    assert.doesNotMatch(serialized, /Bearer\s+[^\s"']+|api[_-]?key\s*[:=]|password\s*[:=]|secret|base64|data:image/i);
    assert.doesNotMatch(serialized, /raw[_-]?input|full[_-]?prompt|authorization/i);
  }
});

test('environment documentation keeps real smoke explicit and outside hosted CI', () => {
  const envExample = readFileSync(join(process.cwd(), '.env.example'), 'utf8');
  const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8');
  const ci = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');

  assert.match(envExample, /CURRENT_REAL_SMOKE/);
  assert.match(envExample, /LLM_PROVIDER=gateway/);
  assert.match(envExample, /TOOL_ADAPTER=real/);
  assert.match(envExample, /LLM_MODEL_NAME=/);
  assert.match(envExample, /TAVILY_API_KEY=/);
  assert.match(envExample, /^CURRENT_DESIGN_SMOKE_IMAGE_PATH=$/m);
  assert.match(envExample, /^CURRENT_SMOKE_SCENARIO=competitive-ai-shopping-assistant$/m);
  assert.match(envExample, /^CURRENT_REQUIRE_BROWSER_EVIDENCE=0$/m);
  assert.match(envExample, /^GOLD_BUILD_ID=$/m);
  assert.match(envExample, /^GOLD_REVIEWER_JWT=$/m);
  assert.match(envExample, /gold:run collect <batch_id>/);
  assert.match(envExample, /gold:run review <batch_id> <attempt_id>/);
  assert.match(envExample, /gold:run decide <batch_id>/);
  assert.match(envExample, /trusted_gold_enabled=false/);
  assert.match(readme, /GitHub-hosted Quality 不运行内网 Gateway Smoke/);
  assert.match(readme, /ALLOW_REAL_PROVIDER=1/);
  assert.match(readme, /pnpm smoke:current:real/);
  assert.doesNotMatch(ci, /ALLOW_REAL_PROVIDER|smoke:current:real|LLM_GATEWAY_API_KEY/);
});
