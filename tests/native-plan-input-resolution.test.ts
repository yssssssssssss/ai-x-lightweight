import assert from 'node:assert/strict';
import test from 'node:test';
import type { NativeSkillInvocation } from '../packages/api-contract/native-skill-orchestration.ts';
import { resolvePlanInputs } from '../apps/orchestrator-runtime/src/input-resolution/resolved-plan-inputs.ts';

function invocation(id: string, acceptedSources: Array<'conversation' | 'upload' | 'database'>): NativeSkillInvocation {
  return {
    invocation_id: id,
    skill_id: id,
    depends_on_invocation_ids: [],
    step_nos: [1],
    required: true,
    failure_policy: 'block',
    run_spec: {
      skill_id: id,
      body: '# Skill',
      body_hash: `sha256:${'1'.repeat(64)}`,
      package_hash: `sha256:${'2'.repeat(64)}`,
      entry_path: 'SKILL.md',
      files: [{ path: 'SKILL.md', mediaType: 'text/markdown', byteSize: 7, contentHash: `sha256:${'1'.repeat(64)}` }],
      selected_references: [],
      input_requirements: [{
        key: 'research_goal', kind: 'value', label: 'Goal', description: 'Goal',
        required: true, multiple: false, acceptedSources, question: 'Goal?',
      }],
      input_requirements_hash: `sha256:${'3'.repeat(64)}`,
      tool_bindings: [],
      report_policy: {
        kind: 'skill_defined', outputFormat: 'markdown', instructions: '# Output',
        instructionsHash: `sha256:${'4'.repeat(64)}`,
      },
    },
  };
}

test('merges shared Multi input requirements and asks once when every target accepts the source', () => {
  const result = resolvePlanInputs({
    invocations: [
      invocation('skill-a', ['conversation']),
      invocation('skill-b', ['conversation', 'upload', 'database']),
    ],
    available: [{
      key: 'research_goal', kind: 'value', valueRef: 'requirement:/research_goal',
      source: 'conversation', authorized: true,
    }],
  });
  assert.equal(result.pending.length, 0);
  assert.deepEqual(result.resolved[0]?.targetInvocationIds, ['skill-a', 'skill-b']);
});

test('keeps a shared input pending when its available source is not accepted by every target', () => {
  const result = resolvePlanInputs({
    invocations: [
      invocation('skill-a', ['conversation']),
      invocation('skill-b', ['conversation', 'upload']),
    ],
    available: [{
      key: 'research_goal', kind: 'value', valueRef: 'upload:research_goal',
      source: 'upload', authorized: true,
    }],
  });
  assert.equal(result.resolved.length, 0);
  assert.deepEqual(result.pending[0]?.requirement.acceptedSources, ['conversation']);
  assert.deepEqual(result.pending[0]?.targetInvocationIds, ['skill-a', 'skill-b']);
});

test('rejects a shared input whose target Skills accept disjoint sources', () => {
  assert.throws(() => resolvePlanInputs({
    invocations: [
      invocation('skill-a', ['conversation']),
      invocation('skill-b', ['upload']),
    ],
    available: [],
  }), /incompatible accepted sources/u);
});
