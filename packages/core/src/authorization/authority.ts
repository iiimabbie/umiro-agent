import type { Capability, CapabilitySet } from "./capability.js";

export type InstructionAuthority = "full" | "scoped" | "none";

export interface ExactResourceScope {
  readonly kind: string;
  readonly id: string;
}

export type VisibilityScope =
  | { readonly kind: "all" }
  | {
      readonly kind: "restricted";
      readonly principalIds: readonly string[];
      readonly labels: readonly string[];
      readonly resources: readonly ExactResourceScope[];
    };

export interface Authority {
  readonly capabilities: CapabilitySet;
  readonly visibility: VisibilityScope;
  readonly instructionAuthority: InstructionAuthority;
}

export interface AuthorityScopeRequest {
  readonly capabilities?: CapabilitySet;
  readonly visibility?: VisibilityScope;
  readonly instructionAuthority?: InstructionAuthority;
}

const INSTRUCTION_RANK: Readonly<Record<InstructionAuthority, number>> = {
  none: 0,
  scoped: 1,
  full: 2,
};

export function isInstructionAuthorityAtMost(
  candidate: InstructionAuthority,
  ceiling: InstructionAuthority,
): boolean {
  return INSTRUCTION_RANK[candidate] <= INSTRUCTION_RANK[ceiling];
}

function resourceKey(resource: ExactResourceScope): string {
  return `${resource.kind}\u0000${resource.id}`;
}

function intersectValues(left: readonly string[], right: readonly string[]): string[] {
  const allowed = new Set(right);
  return [...new Set(left.filter(value => allowed.has(value)))];
}

export function intersectVisibility(left: VisibilityScope, right: VisibilityScope): VisibilityScope {
  if (left.kind === "all") return right;
  if (right.kind === "all") return left;
  const rightResources = new Set(right.resources.map(resourceKey));
  return {
    kind: "restricted",
    principalIds: intersectValues(left.principalIds, right.principalIds),
    labels: intersectValues(left.labels, right.labels),
    resources: left.resources.filter(resource => rightResources.has(resourceKey(resource))),
  };
}

export function isVisibilitySubset(candidate: VisibilityScope, ceiling: VisibilityScope): boolean {
  if (ceiling.kind === "all") return true;
  if (candidate.kind === "all") return false;
  const ceilingPrincipals = new Set(ceiling.principalIds);
  const ceilingLabels = new Set(ceiling.labels);
  const ceilingResources = new Set(ceiling.resources.map(resourceKey));
  return candidate.principalIds.every(value => ceilingPrincipals.has(value))
    && candidate.labels.every(value => ceilingLabels.has(value))
    && candidate.resources.every(value => ceilingResources.has(resourceKey(value)));
}

/** Intersection is the only composition operation: authority can never grow. */
export function intersectAuthority(left: Authority, right: Authority): Authority {
  const rightCapabilities = new Set(right.capabilities);
  const capabilities = [...new Set<Capability>(
    left.capabilities.filter(capability => rightCapabilities.has(capability)),
  )];
  const instructionAuthority = INSTRUCTION_RANK[left.instructionAuthority] <= INSTRUCTION_RANK[right.instructionAuthority]
    ? left.instructionAuthority
    : right.instructionAuthority;
  return {
    capabilities,
    visibility: intersectVisibility(left.visibility, right.visibility),
    instructionAuthority,
  };
}

/** Derive child, scheduled, or plugin authority while enforcing the parent's ceiling. */
export function deriveAuthority(parent: Authority, request: AuthorityScopeRequest): Authority {
  return intersectAuthority(parent, {
    capabilities: request.capabilities ?? parent.capabilities,
    visibility: request.visibility ?? parent.visibility,
    instructionAuthority: request.instructionAuthority ?? parent.instructionAuthority,
  });
}

export function isAuthoritySubset(candidate: Authority, ceiling: Authority): boolean {
  const ceilingCapabilities = new Set(ceiling.capabilities);
  if (candidate.capabilities.some(capability => !ceilingCapabilities.has(capability))) return false;
  if (!isInstructionAuthorityAtMost(candidate.instructionAuthority, ceiling.instructionAuthority)) return false;
  return isVisibilitySubset(candidate.visibility, ceiling.visibility);
}
