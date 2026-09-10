import assert from "node:assert/strict";
import test from "node:test";
import { capabilities, ChildRunService, HeadlessRunEngine, ToolRegistry, type BudgetCeiling, type DelegationRecord, type ExecutionContext, type ModelPort, type Run, type Step, type TaskPackage } from "@umiro/core";
import { SQLiteExecutionStore } from "../src/index.js";

const at = "2026-09-09T00:00:00.000Z";
const authority = { capabilities: capabilities("subagent.delegate"), visibility: { kind: "all" as const }, instructionAuthority: "full" as const };
const execution: ExecutionContext = { actor: { id: "owner", kind: "human", roles: ["owner"] }, origin: { kind: "interactive", transport: "test", conversationId: "c" }, authority };
const task: TaskPackage = { objective: "bounded work", constraints: [], acceptanceCriteria: ["done"], outputContract: { kind: "text" } };

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
    assert.equal((await store.getDelegationByKey("root", "request-1"))?.state, "succeeded");
    assert.equal((await store.getRun(result.childRunId))?.context.authority.capabilities.includes("subagent.delegate"), false);
  } finally { store.close(); }
});

test("only the Parent Run can durably cancel one active Child Run", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  await store.createRunWithStep(run("root"), step("root"));
  await store.createRunWithStep(run("other"), step("other"));
  let started!: () => void;
  const modelStarted = new Promise<void>(resolve => { started = resolve; });
  const childModel: ModelPort = { async generate(request) {
    started();
    return await new Promise((_resolve, reject) => {
      const abort = () => reject(request.signal?.reason ?? new Error("cancelled"));
      if (request.signal?.aborted) abort(); else request.signal?.addEventListener("abort", abort, { once: true });
    });
  } };
  const service = new ChildRunService(new HeadlessRunEngine(childModel, new ToolRegistry(), store), store, { now: () => at, createId: ids() });
  try {
    const execution = service.execute({ parentRunId: "root", idempotencyKey: "cancel-me", task, authorityScope: {}, model: "fake", prompt: "wait" });
    await modelStarted;
    const childRunId = (await store.getDelegationByKey("root", "cancel-me"))!.childRunId;
    await assert.rejects(service.cancel("other", childRunId), /does not belong/);
    assert.deepEqual(await service.cancel("root", childRunId), { cancelled: true, childRunId });
    assert.equal((await execution).status, "cancelled");
    assert.equal((await store.getRun(childRunId))?.state, "cancelled");
    assert.equal((await store.getDelegationByChildRunId(childRunId))?.state, "cancelled");
    assert.ok((await store.listAuditEvents(childRunId)).some(event => event.kind === "delegation.cancelled"));
  } finally { store.close(); }
});

test("Child Runs cannot delegate another Subagent", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  await store.createRunWithStep(run("root"), step("root"));
  const parentBudget = { maxModelTurns: 3, maxToolCalls: 2, maxInputTokens: 20, maxOutputTokens: 10, maxDurationMs: 5_000 };
  await store.createChildRunWithStep(delegation("d1", "root", "child-1", parentBudget), run("child-1", "root"), step("child-1"));
  const service = new ChildRunService(new HeadlessRunEngine(model(), new ToolRegistry(), store), store, { now: () => at, createId: ids() });
  try {
    await assert.rejects(service.execute({ parentRunId: "child-1", idempotencyKey: "nested", task, authorityScope: {}, model: "fake", prompt: "work", budgetCeiling: { maxToolCalls: 1 } }), /cannot delegate another Subagent/);
    assert.equal(await store.getDelegationByKey("child-1", "nested"), undefined);
  } finally { store.close(); }
});

test("active Child Runs are atomically limited per initiating Principal", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  await store.createRunWithStep(run("root-1"), step("root-1"));
  await store.createRunWithStep(run("root-2"), step("root-2"));
  await store.createRunWithStep(run("root-3"), step("root-3"));
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let started = 0;
  const childModel: ModelPort = { async generate() { started += 1; await held; return { text: "done", toolCalls: [], finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 }, assistantMessage: { role: "assistant", content: "done" } }; } };
  const service = new ChildRunService(new HeadlessRunEngine(childModel, new ToolRegistry(), store), store, { now: () => at, createId: ids(), maxActiveChildrenPerPrincipal: 2 });
  try {
    const first = service.execute({ parentRunId: "root-1", idempotencyKey: "one", task, authorityScope: {}, model: "fake", prompt: "one" });
    const second = service.execute({ parentRunId: "root-2", idempotencyKey: "two", task, authorityScope: {}, model: "fake", prompt: "two" });
    while (started < 2) await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(service.execute({ parentRunId: "root-3", idempotencyKey: "three", task, authorityScope: {}, model: "fake", prompt: "three" }), /already has 2 active Child Runs/);
    release();
    assert.deepEqual((await Promise.all([first, second])).map(result => result.status), ["succeeded", "succeeded"]);
  } finally { release(); store.close(); }
});

test("Child output is durably searchable with Parent lineage, visibility, and embedding", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  const parent: Run = {
    ...run("root"),
    conversationId: "conversation-1",
    context: {
      ...execution,
      authority: {
        ...authority,
        visibility: { kind: "restricted", principalIds: ["owner"], labels: [], resources: [{ kind: "conversation", id: "conversation-1" }] },
      },
    },
  };
  await store.createRunWithStep(parent, step("root"));
  const service = new ChildRunService(new HeadlessRunEngine({ async generate() { return { text: "subagent private research result", toolCalls: [], finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 }, assistantMessage: { role: "assistant", content: "subagent private research result" } }; } }, new ToolRegistry(), store), store, { now: () => at, createId: ids() });
  try {
    const result = await service.execute({ parentRunId: "root", idempotencyKey: "indexed", task, authorityScope: {}, model: "fake", prompt: "research" });
    assert.equal(result.status, "succeeded");
    const childRunId = result.childRunId;
    const visible = (await store.search("private research", 10, parent.context.authority.visibility))[0];
    assert.equal(visible?.sourceType, "child_run_output");
    assert.equal(visible?.sourceId, childRunId);
    assert.equal(visible?.conversationId, "conversation-1");
    assert.equal(visible?.actorPrincipalId, "owner");
    assert.equal((await store.search("private research", 10, { kind: "restricted", principalIds: ["stranger"], labels: [], resources: [] })).length, 0);

    const jobs = await store.claimEmbeddingJobs(10, "2026-09-10T00:01:00.000Z", "2026-09-09T23:00:00.000Z");
    const childJob = jobs.find(job => job.documentKey === `document:core:${childRunId}`);
    assert.ok(childJob);
    await store.completeEmbeddingJob(childJob.documentKey, childJob.contentHash, "embedding-model", [1, 0], "2026-09-10T00:01:01.000Z");
    const semantic = (await store.semanticSearch([1, 0], "embedding-model", 10, parent.context.authority.visibility)).find(hit => hit.sourceId === childRunId);
    assert.equal(semantic?.conversationId, "conversation-1");

    await store.rebuildSearchProjection();
    const rebuilt = (await store.search("private research", 10, parent.context.authority.visibility)).find(hit => hit.sourceId === childRunId);
    assert.equal(rebuilt?.actorPrincipalId, "owner");
    const rebuiltJobs = await store.claimEmbeddingJobs(10, "2026-09-10T00:02:00.000Z", "2026-09-09T23:00:00.000Z");
    assert.ok(rebuiltJobs.some(job => job.documentKey === `document:core:${childRunId}`));
  } finally { store.close(); }
});

test("Parent can launch two Children, receive the first report, and cancel the other", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  await store.createRunWithStep(run("root"), step("root"));
  const releases = new Map<string, () => void>();
  const childModel: ModelPort = { async generate(request) {
    await new Promise<void>(resolve => { releases.set(String(request.messages.at(-1)?.content), resolve); });
    return { text: `report:${String(request.messages.at(-1)?.content)}`, toolCalls: [], finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 }, assistantMessage: { role: "assistant", content: "done" } };
  } };
  const service = new ChildRunService(new HeadlessRunEngine(childModel, new ToolRegistry(), store), store, { now: () => at, createId: ids() });
  try {
    const first = await service.start({ parentRunId: "root", idempotencyKey: "first", task, authorityScope: {}, model: "fake", prompt: "A" });
    const second = await service.start({ parentRunId: "root", idempotencyKey: "second", task, authorityScope: {}, model: "fake", prompt: "B" });
    assert.equal(first.status, "active"); assert.equal(second.status, "active");
    while (!releases.has("A") || !releases.has("B")) await new Promise(resolve => setImmediate(resolve));
    releases.get("A")!();
    const report = await service.waitForAny("root", [first.childRunId, second.childRunId]);
    assert.equal(report.childRunId, first.childRunId);
    assert.equal(report.status, "succeeded");
    assert.deepEqual(await service.cancel("root", second.childRunId), { cancelled: true, childRunId: second.childRunId });
    const cancelled = await service.waitForAny("root", [second.childRunId]);
    assert.equal(cancelled.status, "cancelled");
  } finally { releases.forEach(release => release()); store.close(); }
});
