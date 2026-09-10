import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionStore, JsonObject, Operation, OperationResult, Step } from "@umiro/core";
import { observeExecutionStore } from "../src/execution-events.js";

test("durable execution transitions publish bounded versioned Plugin events", async () => {
  const step: Step = { id: "step-1", runId: "run-1", revision: 1, sequence: 0, kind: "operation", state: "running", createdAt: "before", updatedAt: "now" };
  const operation: Operation = { id: "operation-1", stepId: step.id, kind: "tool:discord_send_message", input: { secret: "must-not-leak" }, state: "executing", capability: "discord.message.send", authorizationTier: "common", sideEffect: "idempotent", idempotencyKey: "key", authorizationDecisionId: "decision-1", createdAt: "before", updatedAt: "now" };
  const target = {
    async updateExecutionProgress() {},
    async completeRunWithOutput() {},
    async markOperationExecuting() {},
    async recordOperationOutcome() {},
    async getStep() { return step; },
    async getOperation() { return operation; },
  } as unknown as ExecutionStore;
  const events: Array<{ event: string; payload: JsonObject }> = [];
  let eventSequence = 0;
  const store = observeExecutionStore(target, { async emit(event, payload) { events.push({ event, payload }); } }, { now: () => "2026-09-10T00:00:00.000Z", createEventId: () => `event-${++eventSequence}` });

  await store.updateExecutionProgress({ runId: "run-1", expectedRunRevision: 0, expectedRunState: "queued", runState: "running", resumeEligibility: "eligible", runUpdatedAt: "now", step: { id: step.id, expectedRevision: 0, expectedState: "pending", state: "running", updatedAt: "now" } });
  await store.markOperationExecuting(operation.id, "now");
  const result: OperationResult = { operationId: operation.id, outcome: "succeeded", effectStatus: "confirmed", output: { private: "must-not-leak" }, completedAt: "now" };
  await store.recordOperationOutcome(operation.id, result, "now");
  await store.updateExecutionProgress({ runId: "run-1", expectedRunRevision: 1, expectedRunState: "running", runState: "running", resumeEligibility: "eligible", runUpdatedAt: "now", step: { id: step.id, expectedRevision: 1, expectedState: "running", state: "succeeded", updatedAt: "now" } });
  await store.completeRunWithOutput({ output: { id: "output-1", runId: "run-1", text: "must-not-leak", usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 }, createdAt: "now" }, delivery: { id: "delivery-1", runId: "run-1", destination: {}, payload: { text: "must-not-leak" }, state: "pending", createdAt: "now" }, expectedRunRevision: 2, runUpdatedAt: "now" });

  assert.deepEqual(events.map(item => item.event), ["run.started", "step.started", "tool.started", "tool.completed", "step.completed", "run.completed"]);
  assert.equal(events[0]?.payload.schemaVersion, 1);
  assert.equal(events[0]?.payload.eventId, "event-1");
  assert.equal(events[0]?.payload.occurredAt, "2026-09-10T00:00:00.000Z");
  assert.equal(events[2]?.payload.tool, "discord_send_message");
  assert.equal(events[3]?.payload.effectStatus, "confirmed");
  assert.doesNotMatch(JSON.stringify(events), /must-not-leak/);
});

test("Plugin event sink failure cannot roll back a committed transition", async () => {
  let committed = false;
  const target = { async completeRunWithOutput() { committed = true; } } as unknown as ExecutionStore;
  const store = observeExecutionStore(target, { async emit() { throw new Error("broken hook transport"); } });
  await store.completeRunWithOutput({ output: { id: "output-1", runId: "run-1", text: "ok", usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 }, createdAt: "now" }, delivery: { id: "delivery-1", runId: "run-1", destination: {}, payload: {}, state: "pending", createdAt: "now" }, expectedRunRevision: 1, runUpdatedAt: "now" });
  assert.equal(committed, true);
});
