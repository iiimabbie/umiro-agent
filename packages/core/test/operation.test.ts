import assert from "node:assert/strict";
import test from "node:test";
import {
  assertOperationInvariants,
  assertOperationTransition,
  canTransitionOperation,
  operationRecoveryDisposition,
  type Operation,
} from "../src/index.js";

function operation(values: Partial<Operation> = {}): Operation {
  return {
    id: "operation-1",
    stepId: "step-1",
    kind: "test.echo",
    input: { text: "ping" },
    state: "proposed",
    capability: "test.echo",
    authorizationTier: "common",
    sideEffect: "none",
    createdAt: "2026-09-08T00:00:00.000Z",
    updatedAt: "2026-09-08T00:00:00.000Z",
    ...values,
  };
}

test("operation lifecycle persists authorization before execution", () => {
  assert.equal(canTransitionOperation("proposed", "authorized"), true);
  assert.equal(canTransitionOperation("authorized", "executing"), true);
  assert.equal(canTransitionOperation("executing", "outcome_unknown"), true);
  assert.equal(canTransitionOperation("proposed", "executing"), false);
  assert.throws(() => assertOperationTransition("proposed", "executing"), /invalid operation transition/);
});

test("recovery never blindly replays a non-idempotent external effect", () => {
  assert.equal(operationRecoveryDisposition(operation({ state: "proposed" })), "resume_authorization");
  assert.equal(operationRecoveryDisposition(operation({ state: "authorized" })), "safe_to_execute");
  assert.equal(operationRecoveryDisposition(operation({ state: "executing", sideEffect: "none" })), "safe_to_retry");
  assert.equal(operationRecoveryDisposition(operation({
    state: "executing",
    sideEffect: "idempotent",
    idempotencyKey: "operation-1",
  })), "retry_with_idempotency_key");
  assert.equal(operationRecoveryDisposition(operation({
    state: "executing",
    sideEffect: "non_idempotent",
  })), "mark_outcome_unknown");
  assert.equal(operationRecoveryDisposition(operation({
    state: "outcome_unknown",
    sideEffect: "non_idempotent",
  })), "manual_review");
});

test("side-effect declarations fail closed", () => {
  assert.throws(
    () => assertOperationInvariants({ sideEffect: "idempotent" }),
    /require an idempotency key/,
  );
  assert.throws(
    () => assertOperationInvariants({ sideEffect: "non_idempotent", idempotencyKey: "misleading" }),
    /cannot claim an idempotency key/,
  );
});
