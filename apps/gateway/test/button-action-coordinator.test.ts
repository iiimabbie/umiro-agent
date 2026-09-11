import assert from "node:assert/strict";
import test from "node:test";
import { capabilities, ToolRegistry, ToolRuntime, type ExecutionContext, type Run, type Step } from "@umiro/core";
import { SQLiteExecutionStore } from "@umiro/storage-sqlite";
import { ButtonActionCoordinator, createButtonActionCheckpoint } from "../src/button-action-coordinator.js";

const at = "2026-09-11T00:00:00.000Z";
const context: ExecutionContext = {
  actor: { id: "owner", kind: "human", roles: ["owner"] },
  authority: { capabilities: capabilities("test.button"), visibility: { kind: "all" }, instructionAuthority: "none" },
  origin: { kind: "interactive", transport: "discord", conversationId: "channel" },
};

test("button approval resumes its exact operation without a model cursor", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  const tools = new ToolRegistry();
  let executions = 0;
  tools.register({
    name: "test.button", description: "approved button action", inputSchema: { type: "object", additionalProperties: false, required: ["value"], properties: { value: { type: "string" } } },
    policy: { capability: "test.button", tier: "privileged", interactionRequirement: "interactive_required", approvalRequirement: "required", sideEffect: "idempotent" },
    async execute(input) { executions += 1; return { ok: true, output: input, effectStatus: "confirmed" }; },
  });
  try {
    const run: Run = { id: "run", revision: 0, state: "queued", context, resumeEligibility: "eligible", createdAt: at, updatedAt: at };
    const step: Step = { id: "step", runId: run.id, revision: 0, sequence: 0, kind: "operation", state: "pending", createdAt: at, updatedAt: at };
    await store.createRunWithStep(run, step);
    await store.updateExecutionProgress({ runId: run.id, expectedRunRevision: 0, expectedRunState: "queued", runState: "running", resumeEligibility: "eligible", runUpdatedAt: at, step: { id: step.id, expectedRevision: 0, expectedState: "pending", state: "running", updatedAt: at } });
    const pending = await new ToolRuntime(tools, store, { createId: kind => kind === "operation" ? "operation" : kind === "authorization" ? "authorization" : "approval" }).execute({ toolName: "test.button", input: { value: "one" }, stepId: step.id, runId: run.id, context, idempotencyKey: "button:set:approve" });
    assert.equal(pending.status, "approval_required");
    if (pending.status !== "approval_required") return;
    await store.updateExecutionProgress({ runId: run.id, expectedRunRevision: 1, expectedRunState: "running", runState: "waiting", waitingReason: "approval_required", resumeEligibility: "manual_review", runUpdatedAt: at, checkpoint: { runId: run.id, version: 1, data: createButtonActionCheckpoint("test.button", { value: "one" }), updatedAt: at } });

    const coordinator = new ButtonActionCoordinator(store, tools, () => at);
    assert.equal(await coordinator.handles(pending.approvalId), true);
    assert.deepEqual(await coordinator.resolveAndExecute(pending.approvalId, "approve", context), { approvalState: "approved", runId: "run", status: "succeeded", output: { value: "one" } });
    assert.equal(executions, 1);
    assert.equal((await store.getRun(run.id))?.state, "succeeded");
    assert.equal((await store.getApproval(pending.approvalId))?.state, "consumed");
    assert.equal((await store.getOperation("operation"))?.state, "succeeded");
    assert.equal(await store.getCheckpoint(run.id), undefined);
  } finally { store.close(); }
});

test("a button click records and consumes exact approval before returning", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  const tools = new ToolRegistry();
  let executions = 0;
  tools.register({
    name: "test.button", description: "one-click approved button action", inputSchema: { type: "object", additionalProperties: false, required: ["value"], properties: { value: { type: "string" } } },
    policy: { capability: "test.button", tier: "privileged", interactionRequirement: "interactive_required", approvalRequirement: "required", sideEffect: "idempotent" },
    async execute(input) { executions += 1; return { ok: true, output: input, effectStatus: "confirmed" }; },
  });
  try {
    const coordinator = new ButtonActionCoordinator(store, tools, () => at);
    const result = await coordinator.startAndExecute({ toolName: "test.button", toolInput: { value: "one" }, context, idempotencyKey: "button:set:approve" });
    assert.equal(result.status, "succeeded");
    assert.ok(result.approvalId);
    assert.deepEqual(result.output, { value: "one" });
    assert.equal(executions, 1);
    assert.equal((await store.getRun(result.runId))?.state, "succeeded");
    assert.equal((await store.getApproval(result.approvalId))?.state, "consumed");
  } finally { store.close(); }
});
