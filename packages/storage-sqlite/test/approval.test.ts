import assert from "node:assert/strict";
import test from "node:test";
import { ApprovalService, exactOperationFingerprint, type ApprovalRequest, type AuthorizationDecisionRecord, type ExecutionContext, type JsonObject, type Operation, type Run, type Step } from "@umiro/core";
import { SQLiteExecutionStore } from "../src/index.js";

const requestedAt = "2026-09-09T00:00:00.000Z";
const expiresAt = "2026-09-09T00:05:00.000Z";
const ownerContext: ExecutionContext = { actor: { id: "owner", kind: "human", roles: ["owner"] }, origin: { kind: "interactive", transport: "discord", conversationId: "c" }, authority: { capabilities: ["danger.write"], visibility: { kind: "all" }, instructionAuthority: "full" } };

function operation(input: JsonObject = { path: "a", force: true }): Operation {
  return { id: "operation-1", stepId: "step-1", kind: "tool:danger", input, state: "authorized", capability: "danger.write", authorizationTier: "privileged", sideEffect: "non_idempotent", authorizationDecisionId: "authorization-1", createdAt: requestedAt, updatedAt: requestedAt };
}
function decision(): AuthorizationDecisionRecord {
  return { id: "authorization-1", operationId: "operation-1", allow: true, reason: "granted", policyId: "core.authorization.v1", principalId: "owner", capability: "danger.write", tier: "privileged", interactionRequirement: "interactive_required", resource: { kind: "file", id: "a" }, decidedAt: requestedAt };
}
function approval(op = operation(), auth = decision()): ApprovalRequest {
  return { id: "approval-1", operationId: op.id, fingerprint: exactOperationFingerprint(op, auth), state: "pending", requiredRole: "owner", requestedAt, expiresAt };
}
async function seed(store: SQLiteExecutionStore): Promise<void> {
  const run: Run = { id: "run-1", revision: 0, state: "queued", context: ownerContext, resumeEligibility: "eligible", createdAt: requestedAt, updatedAt: requestedAt };
  const step: Step = { id: "step-1", runId: run.id, revision: 0, sequence: 0, kind: "operation", state: "pending", createdAt: requestedAt, updatedAt: requestedAt };
  await store.createRunWithStep(run, step);
}

test("exact-operation fingerprint is canonical and changes with important parameters", () => {
  const auth = decision();
  assert.equal(exactOperationFingerprint(operation({ force: true, path: "a" }), auth), exactOperationFingerprint(operation({ path: "a", force: true }), auth));
  assert.notEqual(exactOperationFingerprint(operation({ path: "b", force: true }), auth), exactOperationFingerprint(operation({ path: "a", force: true }), auth));
});

test("approval request, resolution, and consumption are durable and audited", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  await seed(store); const op = operation(); const auth = decision(); const request = approval(op, auth);
  try {
    await store.recordOperationAuthorization(op, auth, request);
    assert.deepEqual(await store.getApproval(request.id), request);
    assert.deepEqual(await store.listPendingApprovals(10), [request]);

    const service = new ApprovalService(store, () => "2026-09-09T00:01:00.000Z");
    const resolved = await service.resolve(request.id, "approve", ownerContext);
    assert.equal(resolved.state, "approved");
    await assert.rejects(store.consumeApprovalAndMarkExecuting(op.id, "0".repeat(64), "2026-09-09T00:01:01.000Z"), /fingerprint/);
    assert.equal((await store.getOperation(op.id))?.state, "authorized");

    await store.consumeApprovalAndMarkExecuting(op.id, request.fingerprint, "2026-09-09T00:01:01.000Z");
    assert.equal((await store.getApproval(request.id))?.state, "consumed");
    assert.equal((await store.getOperation(op.id))?.state, "executing");
    await assert.rejects(store.consumeApprovalAndMarkExecuting(op.id, request.fingerprint, "2026-09-09T00:01:02.000Z"), /not executable/);
    assert.deepEqual((await store.listAuditEvents("run-1")).filter(event => event.entityType === "approval").map(event => event.kind), ["approval.requested", "approval.approved", "approval.consumed"]);
  } finally { store.close(); }
});

test("approval resolution requires an interactive owner and expires fail-closed", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  await seed(store); const op = operation(); const auth = decision(); const request = approval(op, auth);
  await store.recordOperationAuthorization(op, auth, request);
  try {
    const member = { ...ownerContext, actor: { id: "member", kind: "human" as const, roles: ["member" as const] } };
    await assert.rejects(new ApprovalService(store).resolve(request.id, "approve", member), /owner/);
    const scheduled = { ...ownerContext, origin: { kind: "schedule" as const, scheduleId: "s" } };
    await assert.rejects(new ApprovalService(store).resolve(request.id, "approve", scheduled), /interactive/);
    const expired = await new ApprovalService(store, () => expiresAt).resolve(request.id, "approve", ownerContext);
    assert.equal(expired.state, "expired");
    assert.equal((await store.getOperation(op.id))?.state, "authorized");
    await assert.rejects(store.consumeApprovalAndMarkExecuting(op.id, request.fingerprint, expiresAt), /not executable/);
  } finally { store.close(); }
});

test("operation results persist artifact references for outbound delivery", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  await seed(store);
  const op = operation(); const auth = decision();
  await store.recordOperationAuthorization(op, auth);
  await store.markOperationExecuting(op.id, "2026-09-09T00:01:00.000Z");
  await store.recordOperationOutcome(op.id, { operationId: op.id, outcome: "succeeded", effectStatus: "confirmed", output: { created: true }, artifactIds: ["artifact-a", "artifact-b"], completedAt: "2026-09-09T00:01:01.000Z" }, "2026-09-09T00:01:01.000Z");
  try { assert.deepEqual((await store.getOperationResult(op.id))?.artifactIds, ["artifact-a", "artifact-b"]); } finally { store.close(); }
});
