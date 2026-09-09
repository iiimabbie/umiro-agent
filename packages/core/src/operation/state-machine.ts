import type { Operation, OperationState } from "./entities.js";

const OPERATION_TRANSITIONS: Readonly<Record<OperationState, readonly OperationState[]>> = {
  proposed: ["authorized", "denied", "cancelled"],
  authorized: ["executing", "failed", "cancelled"],
  denied: [],
  executing: ["succeeded", "failed", "outcome_unknown", "cancelled"],
  succeeded: [],
  failed: [],
  outcome_unknown: ["executing", "succeeded", "failed"],
  cancelled: [],
};

export class InvalidOperationTransitionError extends Error {
  constructor(readonly from: OperationState, readonly to: OperationState) {
    super(`invalid operation transition: ${from} -> ${to}`);
    this.name = "InvalidOperationTransitionError";
  }
}

export function canTransitionOperation(from: OperationState, to: OperationState): boolean {
  return OPERATION_TRANSITIONS[from].includes(to);
}

export function assertOperationTransition(from: OperationState, to: OperationState): void {
  if (!canTransitionOperation(from, to)) throw new InvalidOperationTransitionError(from, to);
}

export type OperationRecoveryDisposition =
  | "resume_authorization"
  | "safe_to_execute"
  | "safe_to_retry"
  | "retry_with_idempotency_key"
  | "mark_outcome_unknown"
  | "manual_review"
  | "no_action";

/** Decide what restart may do without guessing whether an external effect happened. */
export function operationRecoveryDisposition(
  operation: Pick<Operation, "state" | "sideEffect" | "idempotencyKey">,
): OperationRecoveryDisposition {
  if (operation.state === "proposed") return "resume_authorization";
  if (operation.state === "authorized") return "safe_to_execute";
  if (operation.state === "outcome_unknown") {
    if (operation.sideEffect === "none") return "safe_to_retry";
    if (operation.sideEffect === "idempotent" && operation.idempotencyKey?.trim()) {
      return "retry_with_idempotency_key";
    }
    return "manual_review";
  }
  if (operation.state !== "executing") return "no_action";
  if (operation.sideEffect === "none") return "safe_to_retry";
  if (operation.sideEffect === "idempotent" && operation.idempotencyKey?.trim()) {
    return "retry_with_idempotency_key";
  }
  return "mark_outcome_unknown";
}
