import assert from "node:assert/strict";
import test from "node:test";
import { exactOperationFingerprint, type AuthorizationDecisionRecord, type Operation } from "../src/index.js";

const operation: Operation = { id: "operation", stepId: "step", kind: "tool:test", input: { z: 1, "ä": 2, a: { Z: true, "é": false } }, state: "authorized", capability: "test.run", authorizationTier: "privileged", sideEffect: "non_idempotent", authorizationDecisionId: "decision", createdAt: "now", updatedAt: "now" };
const decision: AuthorizationDecisionRecord = { id: "decision", operationId: "operation", allow: true, reason: "granted", policyId: "core.authorization.v1", principalId: "owner", capability: "test.run", tier: "privileged", interactionRequirement: "interactive_required", decidedAt: "now" };

test("approval fingerprint uses locale-independent code-unit key ordering", () => {
  const original = String.prototype.localeCompare;
  try {
    String.prototype.localeCompare = () => { throw new Error("locale-dependent comparison must not be used"); };
    assert.match(exactOperationFingerprint(operation, decision), /^[a-f0-9]{64}$/);
  } finally { String.prototype.localeCompare = original; }
});
