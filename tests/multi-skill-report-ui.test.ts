import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { FinalizedPlan } from '../packages/api-contract/http.ts';
import { hasCompleteContributionSidecars } from '../apps/web/src/report-package-response.ts';
import { multiSkillPlanViewModel } from '../apps/web/src/multi-skill-view-model.ts';
import { groupExecutionSteps } from '../apps/web/src/execution-flow-graph.ts';
import { taskIdFromLocationSearch } from '../apps/web/src/task-link.ts';

function plan(): FinalizedPlan {
  return {
    execution_contract_version: 'current-execution-plan-v3',
    assumptions: [],
    activated_nodes: [],
    capability_demand_graph: {
      version: 'capability-demand-graph-v1',
      demands: [
        {
          id: 'demand-market', type: 'market_landscape', questionIds: ['q1'],
          requestedArtifactTypes: ['strategy_map'], requiredEvidenceClasses: ['public_source'],
          requiredInputRoles: ['research_goal'], priority: 'required',
        },
        {
          id: 'demand-virtual', type: 'virtual_user_hypothesis', questionIds: ['q2'],
          requestedArtifactTypes: [], requiredEvidenceClasses: ['simulation'],
          requiredInputRoles: ['research_goal'], priority: 'required',
        },
      ],
    },
    portfolio_summary: {
      profile_id: 'depth',
      selected: [
        { invocation_id: 'market', skill_id: 'competitive-analysis', role: 'contributor', reason_codes: ['coverage'], estimated_steps: 1 },
        { invocation_id: 'synth', skill_id: 'research-strategy-synthesis', role: 'synthesizer', reason_codes: ['policy'], estimated_steps: 1 },
      ],
      rejected: [],
      shared_prerequisites: [],
      estimated_budget: {
        max_steps: 8, estimated_steps: 2, selected_contributor_count: 1,
        selected_skill_count: 2, required_demand_count: 2, optional_demand_count: 0,
        expanded_step_count: 3, expanded_step_limit: 8,
      },
    },
    contribution_requirements: [{
      id: 'demand-market', demand_type: 'market_landscape', question_ids: ['q1'],
      requested_artifact_types: ['strategy_map'], owner_invocation_id: 'market',
      corroborator_invocation_ids: [], required: true,
    }],
    skill_invocations: [
      {
        invocation_id: 'market', skill_id: 'competitive-analysis', role: 'contributor',
        demand_ids: ['demand-market'],
        contribution_types: ['market_landscape'], question_ids: ['q1'], requested_artifact_types: ['strategy_map'],
        depends_on_invocation_ids: [], output_contract: 'research-contribution-v1', required: true,
        failure_policy: 'block', execution_mode: 'legacy_single_call', step_nos: [2],
      },
      {
        invocation_id: 'synth', skill_id: 'research-strategy-synthesis', role: 'synthesizer',
        demand_ids: ['demand-virtual'],
        contribution_types: ['strategy', 'virtual_user_hypothesis'], question_ids: ['q1', 'q2'], requested_artifact_types: ['strategy_map'],
        depends_on_invocation_ids: ['market'], output_contract: 'reviewed-synthesis-draft-v1', required: true,
        failure_policy: 'block', execution_mode: 'legacy_single_call', step_nos: [3],
      },
    ],
    steps: [
      {
        step_no: 1, step_name: 'Shared Evidence', actor_type: 'tool', actor_id: 'tavily-web-search',
        question_ids: ['q1'], depends_on: [], input: {}, input_bindings: [],
        expected_outputs: [{ pointer: '/results', description: 'results' }], acceptance_criteria: ['verified'],
        requires_approval: false, fallback_actor_ids: [], shared_stage_key: 'shared:tool:tavily',
        shared_by_invocation_ids: ['market', 'synth'], share_fingerprint: `sha256:${'a'.repeat(64)}`,
      },
      {
        step_no: 2, step_name: 'Market', actor_type: 'skill', actor_id: 'competitive-analysis',
        question_ids: ['q1'], depends_on: [1], input: {}, input_bindings: [],
        expected_outputs: [{ pointer: '/contribution', description: 'contribution' }], acceptance_criteria: ['valid'],
        requires_approval: false, fallback_actor_ids: [], skill_invocation_id: 'market', skill_stage_id: 'legacy-call',
      },
      {
        step_no: 3, step_name: 'Synthesis', actor_type: 'skill', actor_id: 'research-strategy-synthesis',
        question_ids: ['q1', 'q2'], depends_on: [2], input: {}, input_bindings: [],
        expected_outputs: [{ pointer: '/payload', description: 'draft' }], acceptance_criteria: ['valid'],
        requires_approval: false, fallback_actor_ids: [], skill_invocation_id: 'synth', skill_stage_id: 'legacy-call',
      },
    ],
  };
}

test('Multi-Skill plan view exposes roles, coverage, budget, and synthetic warning', () => {
  const model = multiSkillPlanViewModel(plan());
  assert.ok(model);
  assert.equal(model.contributorCount, 1);
  assert.equal(model.synthesizer.skill_id, 'research-strategy-synthesis');
  assert.equal(model.requiredDemandCount, 2);
  assert.equal(model.coveredRequiredDemandCount, 2);
  assert.deepEqual(model.uncoveredRequiredDemandIds, []);
  assert.equal(model.synthetic, true);
  assert.deepEqual(model.budget, plan().portfolio_summary?.estimated_budget);
});

test('Multi-Skill plan view keeps early Plan v3 coverage semantics without frozen demand ownership', () => {
  const legacyPlan = plan();
  for (const invocation of legacyPlan.skill_invocations ?? []) {
    if ('role' in invocation) delete invocation.demand_ids;
  }

  const model = multiSkillPlanViewModel(legacyPlan);
  assert.ok(model);
  assert.equal(model.coveredRequiredDemandCount, 1);
  assert.deepEqual(model.uncoveredRequiredDemandIds, ['demand-virtual']);
});

test('execution groups distinguish shared stages and invocation-owned stages', () => {
  assert.deepEqual(groupExecutionSteps(plan().steps).map(({ id, shared, stepNos }) => ({ id, shared, stepNos })), [
    { id: 'shared:tool:tavily', shared: true, stepNos: [1] },
    { id: 'market', shared: false, stepNos: [2] },
    { id: 'synth', shared: false, stepNos: [3] },
  ]);
});

test('generic current-text packages retain the owner Contribution view decision', () => {
  assert.equal(hasCompleteContributionSidecars({
    crossSkillReview: {}, contributionLedger: {}, contributionSummary: {},
  }), true);
  assert.equal(hasCompleteContributionSidecars({ contributionSummary: {} }), false);
});

test('report task links take precedence over stale local task restoration', () => {
  const taskId = '25f05704-62f7-44ab-a6b3-421898bba909';
  assert.equal(taskIdFromLocationSearch(`?report-fixed=${taskId}`), taskId);
  assert.equal(taskIdFromLocationSearch(`?task=${taskId}`), taskId);
  assert.equal(taskIdFromLocationSearch('?report-fixed=not-a-task'), null);
});

test('native Stage4 exposes final report and Skill result views with original and HTML downloads', async () => {
  const reportSource = await readFile(
    join(process.cwd(), 'apps/web/src/components/stages/NativeStage4Report.tsx'),
    'utf8',
  );
  assert.match(reportSource, /export function NativeStage4Report/u);
  assert.match(reportSource, />最终报告</u);
  assert.match(reportSource, />分析明细</u);
  assert.match(reportSource, /controlFinalReportHtml/u);
  assert.match(reportSource, /controlVisualAsset/u);
  assert.match(reportSource, /controlFinalReportZip/u);
  assert.match(reportSource, /HISTORICAL_FINAL_REPORT_VERSION/u);
  assert.match(reportSource, /历史报告 · 只读/u);
  assert.match(reportSource, /下载 Markdown/u);
  assert.match(reportSource, /下载离线报告/u);
  assert.match(reportSource, /下载原始报告/u);
  assert.match(reportSource, /下载 HTML/u);
  assert.match(reportSource, /selectedResult\.primary\.content/u);
  assert.match(reportSource, /selectedResult\.sources/u);
  assert.match(reportSource, /selectedResult\.gaps/u);
  assert.match(reportSource, /sandbox=""/u);
  assert.doesNotMatch(reportSource, /attachShadow|dangerouslySetInnerHTML/u);
});

test('Contribution view stays owner-only/non-canonical and report view mounts it only for complete sidecars', async () => {
  const contributionSource = await readFile(
    join(process.cwd(), 'apps/web/src/components/SkillContributionView.tsx'),
    'utf8',
  );
  const reportSource = await readFile(
    join(process.cwd(), 'apps/web/src/components/stages/CurrentStage4Report.tsx'),
    'utf8',
  );
  assert.match(contributionSource, /仅任务所有者可见 · 非 Canonical 报告/u);
  assert.match(contributionSource, /contributor\.units\.map/u);
  assert.match(contributionSource, /unit\.statement/u);
  assert.match(contributionSource, /unit\.evidenceIds/u);
  assert.match(contributionSource, /unit\.confidence/u);
  assert.match(contributionSource, /unit\.sourceArtifactId/u);
  assert.match(contributionSource, /merged|conflicted|omitted/u);
  assert.match(reportSource, /hasCompleteContributionSidecars\(report\)/u);
});
