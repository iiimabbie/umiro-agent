import assert from "node:assert/strict";
import test from "node:test";
import { capabilities, ChildRunService, HeadlessRunEngine, ToolRegistry, type BudgetCeiling, type DelegationRecord, type ExecutionContext, type ModelPort, type Run, type Step, type TaskPackage } from "@umiro/core";
import { SQLiteExecutionStore } from "../src/index.js";

const at = "2026-09-09T00:00:00.000Z";
const authority = { capabilities: capabilities("subagent.delegate"), visibility: { kind: "all" as const }, instructionAuthority: "full" as const };
const execution: ExecutionContext = { actor: { id: "owner", kind: "human", roles: ["owner"] }, origin: { kind: "interactive", transport: "test", conversationId: "c" }, authority };
const task: TaskPackage = { objective: "bounded work", contextRefs: [], constraints: [], acceptanceCriteria: ["done"], outputContract: { kind: "text" } };

function run(id: string, parentRunId?: string): Run {
  return { id, revision: 0, state: "queued", context: parentRunId ? { ...execution, origin: { kind: "delegation", parentRunId } } : execution, ...(parentRunId ? { parentRunId } : {}), resumeEligibility: "eligible", createdAt: at, updatedAt: at };
}
function step(runId: string): Step { return { id: `step-${runId}`, runId, revision: 0, sequence: 0, kind: "model_call", state: "pending", createdAt: at, updatedAt: at }; }
function delegation(id: string, parentRunId: string, childRunId: string, budgetCeiling?: BudgetCeiling): DelegationRecord {
  return { id, parentRunId, childRunId, idempotencyKey: id, task, ...(budgetCeiling ? { budgetCeiling } : {}), createdAt: at };
}
function ids() { let value = 0; return (kind: "delegation" | "run" | "step") => `${kind}-generated-${++value}`; }
function model(): ModelPort { return { async generate() { return { text: "done", toolCalls: [], finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 }, assistantMessage: { role: "assistant", content: "done" } }; } }; }

test("Child Run persists and enforces all requested budget fields", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  await store.createRunWithStep(run("root"), step("root"));
  let outputLimit: number | undefined;
  const port: ModelPort = { async generate(request) { outputLimit = request.maxOutputTokens; return { text: "done", toolCalls: [], finishReason: "stop", usage: { inputTokens: 2, outputTokens: 1, reasoningTokens: 0 }, assistantMessage: { role: "assistant", content: "done" } }; } };
  const engine = new HeadlessRunEngine(port, new ToolRegistry(), store);
  const service = new ChildRunService(engine, store, { now: () => at, createId: ids() });
  const budgetCeiling = { maxModelTurns: 2, maxToolCalls: 3, maxInputTokens: 8, maxOutputTokens: 7, maxDurationMs: 1_000 };
  try {
    const result = await service.execute({ parentRunId: "root", idempotencyKey: "request-1", task, authorityScope: {}, model: "fake", prompt: "work", budgetCeiling });
    assert.equal(result.status, "succeeded");
    assert.equal(outputLimit, 7);
    assert.deepEqual((await store.getDelegationByKey("root", "request-1"))?.budgetCeiling, budgetCeiling);
  } finally { store.close(); }
});

test("nested delegation inherits Parent ceilings and rejects expansion", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  await store.createRunWithStep(run("root"), step("root"));
  const parentBudget = { maxModelTurns: 3, maxToolCalls: 2, maxInputTokens: 20, maxOutputTokens: 10, maxDurationMs: 5_000 };
  await store.createChildRunWithStep(delegation("d1", "root", "child-1", parentBudget), run("child-1", "root"), step("child-1"));
  const service = new ChildRunService(new HeadlessRunEngine(model(), new ToolRegistry(), store), store, { now: () => at, createId: ids() });
  try {
    await assert.rejects(service.execute({ parentRunId: "child-1", idempotencyKey: "expand", task, authorityScope: {}, model: "fake", prompt: "work", budgetCeiling: { maxToolCalls: 3 } }), /maxToolCalls exceeds Parent ceiling 2/);
    const result = await service.execute({ parentRunId: "child-1", idempotencyKey: "inherit", task, authorityScope: {}, model: "fake", prompt: "work" });
    assert.equal(result.status, "succeeded");
    assert.deepEqual((await store.getDelegationByKey("child-1", "inherit"))?.budgetCeiling, parentBudget);
  } finally { store.close(); }
});

test("delegation depth is bounded before a Child Run is created", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  await store.createRunWithStep(run("root"), step("root"));
  await store.createChildRunWithStep(delegation("d1", "root", "child-1"), run("child-1", "root"), step("child-1"));
  await store.createChildRunWithStep(delegation("d2", "child-1", "child-2"), run("child-2", "child-1"), step("child-2"));
  const service = new ChildRunService(new HeadlessRunEngine(model(), new ToolRegistry(), store), store, { now: () => at, createId: ids(), maxDepth: 2 });
  try {
    await assert.rejects(service.execute({ parentRunId: "child-2", idempotencyKey: "too-deep", task, authorityScope: {}, model: "fake", prompt: "work" }), /delegation depth exceeds 2/);
    assert.equal(await store.getDelegationByKey("child-2", "too-deep"), undefined);
  } finally { store.close(); }
});
