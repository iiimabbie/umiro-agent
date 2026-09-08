import type { AuthorizationTier } from "../authorization/authorize.js";
import type { Capability } from "../authorization/capability.js";
import type { StepId } from "../run/entities.js";

export type OperationId = string;
export type SideEffectClass = "none" | "idempotent" | "non_idempotent";
export type OperationState =
  | "proposed"
  | "authorized"
  | "denied"
  | "executing"
  | "succeeded"
  | "failed"
  | "outcome_unknown"
  | "cancelled";

export interface Operation {
  readonly id: OperationId;
  readonly stepId: StepId;
  readonly kind: string;
  readonly state: OperationState;
  readonly capability: Capability;
  readonly authorizationTier: AuthorizationTier;
  readonly sideEffect: SideEffectClass;
  readonly idempotencyKey?: string;
  readonly authorizationDecisionId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function assertOperationInvariants(operation: Pick<Operation, "sideEffect" | "idempotencyKey">): void {
  if (operation.sideEffect === "idempotent" && !operation.idempotencyKey?.trim()) {
    throw new TypeError("idempotent operations require an idempotency key");
  }
  if (operation.sideEffect === "non_idempotent" && operation.idempotencyKey !== undefined) {
    throw new TypeError("non-idempotent operations cannot claim an idempotency key");
  }
}
