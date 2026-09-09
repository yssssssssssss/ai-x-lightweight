import {
  parseResolvedPlanInputs,
  parseSkillInputRequirements,
  type NativeSkillInvocation,
  type MaterialInputSource,
  type ResolvedPlanInputs,
  type SkillInputKind,
  type SkillInputRequirement,
} from '../../../../packages/api-contract/native-skill-orchestration.ts';

export interface ResolvablePlanInput {
  key: string;
  kind: SkillInputKind;
  valueRef: string;
  source: MaterialInputSource;
  authorized: boolean;
}

export interface WaivedInputDecision {
  key: string;
  reason: string;
}

export class PlanInputResolutionError extends Error {
  constructor(message: string) {
    super(`plan input resolution failed: ${message}`);
    this.name = 'PlanInputResolutionError';
  }
}

const SOURCE_PRIORITY: Readonly<Record<MaterialInputSource, number>> = {
  conversation: 0,
  upload: 1,
  database: 2,
};

function mergeRequirement(
  current: SkillInputRequirement,
  candidate: SkillInputRequirement,
): SkillInputRequirement {
  if (
    current.kind !== candidate.kind
    || current.multiple !== candidate.multiple
  ) {
    throw new PlanInputResolutionError(`requirement ${current.key} has incompatible declarations`);
  }
  const acceptedSources = current.acceptedSources.filter((source) => (
    candidate.acceptedSources.includes(source)
  ));
  if (acceptedSources.length === 0) {
    throw new PlanInputResolutionError(`requirement ${current.key} has incompatible accepted sources`);
  }
  return {
    ...current,
    required: current.required || candidate.required,
    acceptedSources,
  };
}

export function resolvePlanInputs(input: {
  invocations: ReadonlyArray<Pick<NativeSkillInvocation, 'invocation_id' | 'run_spec'>>;
  available: readonly ResolvablePlanInput[];
  waived?: readonly WaivedInputDecision[];
  executionBoundKeys?: readonly string[];
}): ResolvedPlanInputs {
  const requirements = new Map<string, {
    requirement: SkillInputRequirement;
    targetInvocationIds: string[];
  }>();
  const invocationIds = new Set<string>();
  for (const invocation of input.invocations) {
    if (invocationIds.has(invocation.invocation_id)) {
      throw new PlanInputResolutionError(`invocation ${invocation.invocation_id} is duplicated`);
    }
    invocationIds.add(invocation.invocation_id);
    const declared = parseSkillInputRequirements(invocation.run_spec.input_requirements);
    for (const requirement of declared) {
      const existing = requirements.get(requirement.key);
      if (!existing) {
        requirements.set(requirement.key, {
          requirement,
          targetInvocationIds: [invocation.invocation_id],
        });
        continue;
      }
      existing.requirement = mergeRequirement(existing.requirement, requirement);
      existing.targetInvocationIds.push(invocation.invocation_id);
    }
  }

  const availableByKey = new Map<string, ResolvablePlanInput[]>();
  for (const candidate of input.available) {
    if (!candidate.authorized) {
      throw new PlanInputResolutionError(`input ${candidate.key} is not authorized`);
    }
    if (!candidate.valueRef.trim()) {
      throw new PlanInputResolutionError(`input ${candidate.key} has no value reference`);
    }
    const matches = availableByKey.get(candidate.key) ?? [];
    matches.push(candidate);
    availableByKey.set(candidate.key, matches);
  }
  for (const candidates of availableByKey.values()) {
    candidates.sort((left, right) => SOURCE_PRIORITY[left.source] - SOURCE_PRIORITY[right.source]);
  }

  const waivedByKey = new Map<string, string>();
  for (const decision of input.waived ?? []) {
    if (!decision.key.trim() || !decision.reason.trim() || waivedByKey.has(decision.key)) {
      throw new PlanInputResolutionError(`waiver ${decision.key || '(empty)'} is invalid`);
    }
    waivedByKey.set(decision.key, decision.reason);
  }
  const executionBoundKeys = new Set(input.executionBoundKeys ?? []);
  const resolved: ResolvedPlanInputs['resolved'] = [];
  const pending: ResolvedPlanInputs['pending'] = [];
  const waived: ResolvedPlanInputs['waived'] = [];

  for (const { requirement, targetInvocationIds } of requirements.values()) {
    const candidates = availableByKey.get(requirement.key) ?? [];
    const selected = candidates.find((candidate) => (
      candidate.kind === requirement.kind
      && requirement.acceptedSources.includes(candidate.source)
    ));
    if (selected) {
      resolved.push({
        key: requirement.key,
        valueRef: selected.valueRef,
        source: selected.source,
        targetInvocationIds: [...targetInvocationIds],
      });
      continue;
    }
    if (
      executionBoundKeys.has(requirement.key)
      && requirement.acceptedSources.some((source) => source === 'knowledge' || source === 'tool')
    ) {
      continue;
    }
    const waiverReason = waivedByKey.get(requirement.key);
    if (waiverReason !== undefined) {
      if (requirement.required) {
        throw new PlanInputResolutionError(`required input ${requirement.key} cannot be waived`);
      }
      waived.push({
        key: requirement.key,
        targetInvocationIds: [...targetInvocationIds],
        reason: waiverReason,
      });
      continue;
    }
    pending.push({
      requirement,
      targetInvocationIds: [...targetInvocationIds],
    });
  }

  for (const key of waivedByKey.keys()) {
    if (!requirements.has(key)) throw new PlanInputResolutionError(`waiver ${key} has no requirement`);
  }

  return parseResolvedPlanInputs({ resolved, pending, waived });
}
