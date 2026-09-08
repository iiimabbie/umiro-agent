import type { ExecutionContext } from "../identity/execution-context.js";
import { isOwner, type PrincipalId } from "../identity/principal.js";
import type { Capability } from "./capability.js";
import { hasCapability } from "./capability.js";

export type AuthorizationTier = "common" | "sensitive" | "privileged";

export interface ResourceRef {
  readonly kind: string;
  readonly id: string;
  readonly ownerPrincipalId?: PrincipalId;
  readonly labels?: readonly string[];
}

export interface AuthorizationRequest {
  readonly context: ExecutionContext;
  readonly capability: Capability;
  readonly tier: AuthorizationTier;
  readonly resource?: ResourceRef;
}

export type AuthorizationReason =
  | "granted"
  | "capability_not_granted"
  | "resource_required"
  | "resource_outside_visibility"
  | "owner_required";

export interface AuthorizationDecision {
  readonly allow: boolean;
  readonly reason: AuthorizationReason;
  readonly policyId: "core.authorization.v1";
  readonly principalId: PrincipalId;
  readonly capability: Capability;
  readonly tier: AuthorizationTier;
  readonly resource?: ResourceRef;
}

function resourceVisible(request: AuthorizationRequest): boolean {
  const visibility = request.context.authority.visibility;
  if (visibility.kind === "all") return true;
  const resource = request.resource;
  if (!resource) return false;
  if (resource.ownerPrincipalId && visibility.principalIds.includes(resource.ownerPrincipalId)) return true;
  if ((resource.labels ?? []).some(label => visibility.labels.includes(label))) return true;
  return visibility.resources.some(candidate => candidate.kind === resource.kind && candidate.id === resource.id);
}

export function authorize(request: AuthorizationRequest): AuthorizationDecision {
  const base = {
    policyId: "core.authorization.v1",
    principalId: request.context.actor.id,
    capability: request.capability,
    tier: request.tier,
    ...(request.resource ? { resource: request.resource } : {}),
  } as const;

  if (!hasCapability(request.context.authority.capabilities, request.capability)) {
    return { ...base, allow: false, reason: "capability_not_granted" };
  }
  if (request.tier === "sensitive" && !request.resource) {
    return { ...base, allow: false, reason: "resource_required" };
  }
  if (request.resource && request.tier !== "common" && !resourceVisible(request)) {
    return { ...base, allow: false, reason: "resource_outside_visibility" };
  }
  if (request.tier === "privileged" && !isOwner(request.context.actor)) {
    return { ...base, allow: false, reason: "owner_required" };
  }
  return { ...base, allow: true, reason: "granted" };
}
