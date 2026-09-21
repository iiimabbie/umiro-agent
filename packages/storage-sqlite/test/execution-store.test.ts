import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  authorize,
  capabilities,
  ExecutionStoreConflictError,
  operationRecoveryDisposition,
  type AuthorizationDecisionRecord,
  type ExecutionContext,
  type Operation,
  type OperationResult,
  type Run,
  type Step,
} from "@umiro/core";
import { SQLiteExecutionStore } from "../src/index.js";

const at = "2026-09-08T12:00:00.000Z";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "umiro-storage-test-"));
  const filename = join(directory, "execution.db");
  const store = new SQLiteExecutionStore(filename);
  return {
    filename,
    store,
    cleanup() {
      try { store.close(); } catch { /* already closed */ }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function executionContext(): ExecutionContext {
  return {
    actor: { id: "owner", kind: "human", roles: ["owner"] },
    origin: { kind: "interactive", transport: "discord", conversationId: "conversation-1" },
    authority: {
      capabilities: capabilities("test.echo"),
      visibility: { kind: "all" },
      instructionAuthority: "full",
    },
  };
}

function run(id = "run-1"): Run {
  return {
    id,
    revision: 0,
    state: "queued",
    context: executionContext(),
    conversationId: "conversation-1",
    turnId: "turn-1",
    resumeEligibility: "not_applicable",
    createdAt: at,
    updatedAt: at,
  };
}

function step(runId = "run-1", id = "step-1"): Step {
  return { id, runId, revision: 0, sequence: 0, kind: "operation", state: "pending", createdAt: at, updatedAt: at };
}

function authorizedOperation(id = "operation-1", stepId = "step-1"): { operation: Operation; decision: AuthorizationDecisionRecord } {
  const baseDecision = authorize({ context: executionContext(), capability: "test.echo", tier: "common" });
  const decision: AuthorizationDecisionRecord = {
    ...baseDecision,
    id: `decision-${id}`,
    operationId: id,
    decidedAt: at,
  };
  return {
    operation: {
      id,
      stepId,
      kind: "test.echo",
      input: { text: "ping" },
      state: "authorized",
      capability: "test.echo",
      authorizationTier: "common",
      sideEffect: "idempotent",
      idempotencyKey: id,
      authorizationDecisionId: decision.id,
      createdAt: at,
      updatedAt: at,
    },
    decision,
  };
}

test("persists an execution atomically and survives close/reopen", async () => {
  const database = fixture();
  try {
    await database.store.createRunWithStep(run(), step());
    await database.store.updateExecutionProgress({
      runId: "run-1",
      expectedRunRevision: 0,
      expectedRunState: "queued",
      runState: "running",
      resumeEligibility: "eligible",
      runUpdatedAt: at,
      step: { id: "step-1", expectedRevision: 0, expectedState: "pending", state: "running", updatedAt: at },
      checkpoint: { runId: "run-1", version: 1, data: { next: "operation-1" }, updatedAt: at },
    });
    const { operation, decision } = authorizedOperation();
    await database.store.recordOperationAuthorization(operation, decision);
    await database.store.markOperationExecuting(operation.id, at);
    const result: OperationResult = {
      operationId: operation.id,
      outcome: "succeeded",
      effectStatus: "confirmed",
      output: { text: "pong" },
      modelInputArtifactIds: ["artifact-model-only"],
      completedAt: at,
    };
    await database.store.recordOperationOutcome(operation.id, result, at);
    await database.store.updateExecutionProgress({
      runId: "run-1",
      expectedRunRevision: 1,
      expectedRunState: "running",
      runState: "succeeded",
      resumeEligibility: "not_applicable",
      runUpdatedAt: at,
      step: { id: "step-1", expectedRevision: 1, expectedState: "running", state: "succeeded", updatedAt: at },
      clearCheckpoint: true,
    });
    database.store.close();

    const reopened = new SQLiteExecutionStore(database.filename);
    try {
      assert.deepEqual(await reopened.getRun("run-1"), { ...run(), revision: 2, state: "succeeded" });
      assert.deepEqual(
        { state: (await reopened.getStep("step-1"))?.state, revision: (await reopened.getStep("step-1"))?.revision },
        { state: "succeeded", revision: 2 },
      );
      assert.equal((await reopened.getOperation("operation-1"))?.state, "succeeded");
      assert.deepEqual(await reopened.getAuthorizationDecision(decision.id), decision);
      assert.deepEqual(await reopened.getOperationResult(operation.id), result);
      assert.equal(await reopened.getCheckpoint("run-1"), undefined);
      assert.deepEqual(
        (await reopened.listAuditEvents("run-1")).map(event => event.kind),
        ["run.created", "step.created", "run.progressed", "operation.authorization_decided", "operation.executing", "operation.completed", "run.progressed"],
      );
    } finally {
      reopened.close();
    }
  } finally {
    database.cleanup();
  }
});

test("lists recent runs newest first with a bounded limit", async () => {
  const database = fixture();
  try {
    await database.store.createRunWithStep({ ...run("run-old"), createdAt: "2026-09-08T10:00:00.000Z", updatedAt: "2026-09-08T10:00:00.000Z" }, step("run-old", "step-old"));
    await database.store.createRunWithStep({ ...run("run-new"), createdAt: "2026-09-08T11:00:00.000Z", updatedAt: "2026-09-08T11:00:00.000Z" }, step("run-new", "step-new"));
    assert.deepEqual((await database.store.listRuns(1)).map(item => item.id), ["run-new"]);
    await assert.rejects(database.store.listRuns(0), /between 1 and 200/);
    await assert.rejects(database.store.listRuns(201), /between 1 and 200/);
  } finally { database.cleanup(); }
});

test("lists only one conversation's runs and delegated descendants", async () => {
  const database = fixture();
  try {
    await database.store.createRunWithStep({ ...run("run-old"), createdAt: "2026-09-08T10:00:00.000Z", updatedAt: "2026-09-08T10:00:00.000Z" }, step("run-old", "step-old"));
    await database.store.createRunWithStep({ ...run("run-other"), conversationId: "conversation-2", turnId: "turn-2", createdAt: "2026-09-08T11:00:00.000Z", updatedAt: "2026-09-08T11:00:00.000Z" }, step("run-other", "step-other"));
    const { conversationId: _conversationId, turnId: _turnId, ...child } = run("run-child");
    await database.store.createRunWithStep({ ...child, parentRunId: "run-old", createdAt: "2026-09-08T12:00:00.000Z", updatedAt: "2026-09-08T12:00:00.000Z" }, step("run-child", "step-child"));

    assert.deepEqual((await database.store.listConversationRuns("conversation-1")).map(item => item.id), ["run-child", "run-old"]);
    assert.deepEqual((await database.store.listConversationRuns("conversation-1", 1)).map(item => item.id), ["run-child"]);
    await assert.rejects(database.store.listConversationRuns("", 1), /conversation ID/);
    await assert.rejects(database.store.listConversationRuns("conversation-1", 201), /between 1 and 200/);
  } finally { database.cleanup(); }
});

test("rolls back the decision when its operation cannot be inserted", async () => {
  const database = fixture();
  try {
    await database.store.createRunWithStep(run(), step());
    const { operation, decision } = authorizedOperation("orphan-operation", "missing-step");
    await assert.rejects(
      database.store.recordOperationAuthorization(operation, decision),
      /FOREIGN KEY constraint failed/,
    );
    assert.equal(await database.store.getAuthorizationDecision(decision.id), undefined);
    assert.equal((await database.store.listAuditEvents("run-1")).length, 2);
  } finally {
    database.cleanup();
  }
});

test("reopens an in-flight operation with enough evidence for safe recovery", async () => {
  const database = fixture();
  try {
    await database.store.createRunWithStep(run(), step());
    await database.store.updateExecutionProgress({
      runId: "run-1",
      expectedRunRevision: 0,
      expectedRunState: "queued",
      runState: "running",
      resumeEligibility: "eligible",
      runUpdatedAt: at,
      step: { id: "step-1", expectedRevision: 0, expectedState: "pending", state: "running", updatedAt: at },
      checkpoint: { runId: "run-1", version: 1, data: { next: "operation-1" }, updatedAt: at },
    });
    const { operation, decision } = authorizedOperation();
    await database.store.recordOperationAuthorization(operation, decision);
    await database.store.markOperationExecuting(operation.id, at);
    database.store.close();

    const reopened = new SQLiteExecutionStore(database.filename);
    try {
      const persisted = await reopened.getOperation(operation.id);
      assert.ok(persisted);
      assert.equal(persisted.state, "executing");
      assert.equal(operationRecoveryDisposition(persisted), "retry_with_idempotency_key");
      assert.deepEqual((await reopened.listRecoverableRuns()).map(candidate => candidate.id), ["run-1"]);
    } finally {
      reopened.close();
    }
  } finally {
    database.cleanup();
  }
});

test("replaces an unknown current outcome after an idempotent retry", async () => {
  const database = fixture();
  try {
    await database.store.createRunWithStep(run(), step());
    const { operation, decision } = authorizedOperation();
    await database.store.recordOperationAuthorization(operation, decision);
    await database.store.markOperationExecuting(operation.id, at);
    await database.store.recordOperationOutcome(operation.id, {
      operationId: operation.id,
      outcome: "outcome_unknown",
      effectStatus: "unknown",
      error: { code: "connection_lost", message: "confirmation was lost", retryable: true },
      completedAt: at,
    }, at);
    await database.store.markOperationExecuting(operation.id, "2026-09-08T12:01:00.000Z");
    await database.store.recordOperationOutcome(operation.id, {
      operationId: operation.id,
      outcome: "succeeded",
      effectStatus: "confirmed",
      output: { text: "confirmed" },
      completedAt: "2026-09-08T12:01:01.000Z",
    }, "2026-09-08T12:01:01.000Z");
    assert.deepEqual(await database.store.getOperationResult(operation.id), {
      operationId: operation.id,
      outcome: "succeeded",
      effectStatus: "confirmed",
      output: { text: "confirmed" },
      completedAt: "2026-09-08T12:01:01.000Z",
    });
    assert.deepEqual(
      (await database.store.listAuditEvents("run-1")).map(event => event.kind).slice(-4),
      ["operation.executing", "operation.completed", "operation.executing", "operation.completed"],
    );
  } finally {
    database.cleanup();
  }
});

test("rolls back run progress when checkpoint compare-and-swap fails", async () => {
  const database = fixture();
  try {
    await database.store.createRunWithStep(run(), step());
    await database.store.updateExecutionProgress({
      runId: "run-1",
      expectedRunRevision: 0,
      expectedRunState: "queued",
      runState: "running",
      resumeEligibility: "eligible",
      runUpdatedAt: at,
      checkpoint: { runId: "run-1", version: 1, data: { value: 1 }, updatedAt: at },
    });
    await assert.rejects(
      database.store.updateExecutionProgress({
        runId: "run-1",
        expectedRunRevision: 1,
        expectedRunState: "running",
        runState: "waiting",
        resumeEligibility: "eligible",
        waitingReason: "tool_result",
        runUpdatedAt: "2026-09-08T12:01:00.000Z",
        checkpoint: { runId: "run-1", version: 3, data: { value: 3 }, updatedAt: at },
      }),
      ExecutionStoreConflictError,
    );
    assert.equal((await database.store.getRun("run-1"))?.state, "running");
    assert.deepEqual((await database.store.getCheckpoint("run-1"))?.data, { value: 1 });
    assert.equal((await database.store.listAuditEvents("run-1")).length, 3);
  } finally {
    database.cleanup();
  }
});

test("rejects stale state transitions instead of overwriting newer state", async () => {
  const database = fixture();
  try {
    await database.store.createRunWithStep(run(), step());
    await database.store.updateExecutionProgress({
      runId: "run-1",
      expectedRunRevision: 0,
      expectedRunState: "queued",
      runState: "running",
      resumeEligibility: "eligible",
      runUpdatedAt: at,
    });
    await assert.rejects(
      database.store.updateExecutionProgress({
        runId: "run-1",
        expectedRunRevision: 0,
        expectedRunState: "queued",
        runState: "cancelled",
        resumeEligibility: "ineligible",
        runUpdatedAt: at,
      }),
      /changed concurrently/,
    );
    assert.equal((await database.store.getRun("run-1"))?.state, "running");
  } finally {
    database.cleanup();
  }
});

test("rolls back run completion when the output cannot be persisted", async () => {
  const database = fixture();
  try {
    await database.store.createRunWithStep(run("run-1"), step("run-1", "step-1"));
    await database.store.updateExecutionProgress({
      runId: "run-1",
      expectedRunRevision: 0,
      expectedRunState: "queued",
      runState: "running",
      resumeEligibility: "eligible",
      runUpdatedAt: at,
      checkpoint: { runId: "run-1", version: 1, data: { messages: [] }, updatedAt: at },
    });
    await database.store.completeRunWithOutput({
      output: {
        id: "shared-output",
        runId: "run-1",
        text: "first",
        usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 },
        createdAt: at,
      },
      delivery: {
        id: "delivery-1",
        runId: "run-1",
        destination: { kind: "test" },
        payload: { text: "first" },
        state: "pending",
        createdAt: at,
      },
      expectedRunRevision: 1,
      runUpdatedAt: at,
    });

    await database.store.createRunWithStep(run("run-2"), step("run-2", "step-2"));
    await database.store.updateExecutionProgress({
      runId: "run-2",
      expectedRunRevision: 0,
      expectedRunState: "queued",
      runState: "running",
      resumeEligibility: "eligible",
      runUpdatedAt: at,
      checkpoint: { runId: "run-2", version: 1, data: { messages: [] }, updatedAt: at },
    });
    await assert.rejects(
      database.store.completeRunWithOutput({
        output: {
          id: "shared-output",
          runId: "run-2",
          text: "second",
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 },
          createdAt: at,
        },
        delivery: {
          id: "delivery-2",
          runId: "run-2",
          destination: { kind: "test" },
          payload: { text: "second" },
          state: "pending",
          createdAt: at,
        },
        expectedRunRevision: 1,
        runUpdatedAt: at,
      }),
      /UNIQUE constraint failed/,
    );

    assert.equal((await database.store.getRun("run-2"))?.state, "running");
    assert.equal((await database.store.getCheckpoint("run-2"))?.version, 1);
    assert.equal(await database.store.getRunOutput("run-2"), undefined);
  } finally {
    database.cleanup();
  }
});

test("completed assistant output joins the turn search and embedding projections", async () => {
  const database = fixture();
  try {
    await database.store.findOrCreate({ transport: "discord", externalId: "123456789012345678", principalId: "owner", displayName: "小明" }, at);
    await database.store.createConversationWithTurn(
      { id: "conversation-1", revision: 0, state: "active", createdAt: at, updatedAt: at },
      { id: "turn-1", conversationId: "conversation-1", sequence: 0, actorPrincipalId: "owner", actorIdentity: { transport: "discord", externalId: "123456789012345678" }, inputEventId: "event-1", primaryRunId: "run-1", content: [{ type: "text", text: "使用者問題" }], createdAt: at },
    );
    await database.store.createRunWithStep(run(), step());
    await database.store.updateExecutionProgress({ runId: "run-1", expectedRunRevision: 0, expectedRunState: "queued", runState: "running", resumeEligibility: "eligible", runUpdatedAt: at });
    await database.store.completeRunWithOutput({
      output: { id: "output-search", runId: "run-1", text: "授權設計的結論是最小權限", usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 }, createdAt: at },
      delivery: { id: "delivery-search", runId: "run-1", destination: { kind: "test" }, payload: { text: "done" }, state: "pending", createdAt: at },
      expectedRunRevision: 1, runUpdatedAt: at,
    });
    assert.equal((await database.store.search("最小權限", 10, { kind: "all" }))[0]?.turnId, "turn-1");
    assert.equal((await database.store.getHistoryItem("turn-1"))?.actorDisplayName, "小明");
    assert.equal((await database.store.getHistoryItem("turn-1"))?.assistantCreatedAt, at);
    const [job] = await database.store.claimEmbeddingJobs(10, "2026-09-08T12:01:00.000Z", "2026-09-08T11:00:00.000Z");
    assert.match(job?.text ?? "", /使用者問題[\s\S]*最小權限/);
    await database.store.rebuildSearchProjection();
    assert.equal((await database.store.search("授權設計", 10, { kind: "all" }))[0]?.turnId, "turn-1");
  } finally { database.cleanup(); }
});

test("tool call and result evidence is searchable, rebuildable, bounded, and redacted", async () => {
  const database = fixture();
  const secret = "sk-this-must-never-be-indexed";
  try {
    await database.store.createConversationWithTurn(
      { id: "conversation-1", revision: 0, state: "active", createdAt: at, updatedAt: at },
      { id: "turn-1", conversationId: "conversation-1", sequence: 0, actorPrincipalId: "owner", inputEventId: "event-1", primaryRunId: "run-1", content: [{ type: "text", text: "請查工具執行紀錄" }], createdAt: at },
    );
    await database.store.createRunWithStep(run(), step());
    await database.store.updateExecutionProgress({ runId: "run-1", expectedRunRevision: 0, expectedRunState: "queued", runState: "running", resumeEligibility: "eligible", runUpdatedAt: at, step: { id: "step-1", expectedRevision: 0, expectedState: "pending", state: "running", updatedAt: at } });
    const authorized = authorizedOperation();
    const operation = { ...authorized.operation, input: { query: "Taipei forecast", apiKey: secret } };
    await database.store.recordOperationAuthorization(operation, authorized.decision);
    const [callJob] = await database.store.claimEmbeddingJobs(10, "2026-09-08T12:00:10.000Z", "2026-09-08T11:00:00.000Z");
    await database.store.completeEmbeddingJob(callJob!.documentKey, callJob!.contentHash, "embedding-model", [1, 0], "2026-09-08T12:00:11.000Z");
    await database.store.markOperationExecuting(operation.id, at);
    await database.store.recordOperationOutcome(operation.id, { operationId: operation.id, outcome: "succeeded", effectStatus: "confirmed", output: { forecast: "sunny evidence", authorization: `Bearer ${secret}`, oversized: "x".repeat(100_000) }, completedAt: at }, at);
    const [outcomeJob] = await database.store.claimEmbeddingJobs(10, "2026-09-08T12:00:20.000Z", "2026-09-08T11:00:00.000Z");
    assert.notEqual(outcomeJob?.contentHash, callJob?.contentHash);

    const liveHit = (await database.store.search("sunny evidence", 10, { kind: "all" }))[0];
    assert.equal(liveHit?.turnId, "turn-1");
    assert.match(liveHit?.text ?? "", /Tool: test\.echo[\s\S]*Outcome: succeeded/);
    assert.doesNotMatch(liveHit?.text ?? "", new RegExp(secret));
    assert.ok((liveHit?.text.length ?? Infinity) < 15_000);
    assert.match((await database.store.getHistoryItem("turn-1"))?.toolEvidence ?? "", /sunny evidence/);
    assert.doesNotMatch((await database.store.getHistoryItem("turn-1"))?.toolEvidence ?? "", new RegExp(secret));
    const recent = await database.store.listRecentHistory("conversation-1", 2, 10);
    assert.equal(recent.length, 1);
    assert.match(recent[0]?.toolEvidence ?? "", /sunny evidence/);
    assert.doesNotMatch(recent[0]?.toolEvidence ?? "", new RegExp(secret));

    await database.store.completeRunWithOutput({
      output: { id: "output-tool-search", runId: "run-1", text: "工具查詢完成", usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 }, createdAt: at },
      delivery: { id: "delivery-tool-search", runId: "run-1", destination: { kind: "test" }, payload: { text: "done" }, state: "pending", createdAt: at },
      expectedRunRevision: 1,
      runUpdatedAt: at,
    });
    const [job] = await database.store.claimEmbeddingJobs(10, "2026-09-08T12:01:00.000Z", "2026-09-08T11:00:00.000Z");
    assert.match(job?.text ?? "", /sunny evidence/);
    assert.doesNotMatch(job?.text ?? "", new RegExp(secret));

    await database.store.rebuildSearchProjection();
    const rebuilt = (await database.store.search("Taipei forecast", 10, { kind: "all" }))[0];
    assert.equal(rebuilt?.turnId, "turn-1");
    assert.doesNotMatch(rebuilt?.text ?? "", new RegExp(secret));
  } finally { database.cleanup(); }
});

test("builds a bounded rebuildable compaction without deleting canonical turns", async () => {
  const database = fixture();
  try {
    await database.store.createConversationWithTurn(
      { id: "conversation-1", revision: 0, state: "active", createdAt: at, updatedAt: at },
      { id: "turn-0", conversationId: "conversation-1", sequence: 0, actorPrincipalId: "owner", inputEventId: "event-0", content: [{ type: "text", text: "最早的長期決策：外掛不能擴張權限" }], createdAt: at },
    );
    for (let sequence = 1; sequence < 30; sequence++) {
      await database.store.appendTurn({
        turn: { id: `turn-${sequence}`, conversationId: "conversation-1", sequence, actorPrincipalId: "owner", inputEventId: `event-${sequence}`, content: [{ type: "text", text: `第 ${sequence} 輪內容 ${"細節".repeat(80)}` }], createdAt: at },
        expectedConversationRevision: sequence - 1,
        conversationUpdatedAt: at,
      });
    }
    assert.equal(await database.store.refreshConversationCompaction({ conversationId: "conversation-1", beforeSequence: 24, retainRecent: 24, maxCharacters: 1000, updatedAt: at }), undefined);
    const compacted = await database.store.refreshConversationCompaction({ conversationId: "conversation-1", beforeSequence: 29, retainRecent: 24, maxCharacters: 1000, updatedAt: at });
    assert.equal(compacted?.throughSequence, 4);
    assert.ok((compacted?.summary.length ?? 1001) <= 1000);
    assert.match(compacted?.summary ?? "", /外掛不能擴張權限/);
    const unchanged = await database.store.refreshConversationCompaction({ conversationId: "conversation-1", beforeSequence: 29, retainRecent: 24, maxCharacters: 1000, updatedAt: "later" });
    assert.equal(unchanged?.updatedAt, at);
    assert.equal((await database.store.listTurns("conversation-1")).length, 30);
  } finally { database.cleanup(); }
});

test("delivery retry state and external evidence survive reopen", async () => {
  const database = fixture();
  try {
    await database.store.createRunWithStep(run(), step());
    await database.store.updateExecutionProgress({ runId: "run-1", expectedRunRevision: 0, expectedRunState: "queued", runState: "running", resumeEligibility: "eligible", runUpdatedAt: at });
    await database.store.completeRunWithOutput({ output: { id: "output-retry", runId: "run-1", text: "hello", usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 }, createdAt: at }, delivery: { id: "delivery-retry", runId: "run-1", destination: { kind: "discord", channelId: "c" }, payload: { text: "hello" }, state: "pending", createdAt: at }, expectedRunRevision: 1, runUpdatedAt: at });
    await database.store.markDeliveryFailed("delivery-retry", "rate limited", "2026-09-08T12:01:00.000Z", "2026-09-08T12:00:01.000Z");
    assert.equal((await database.store.listPendingDeliveries("2026-09-08T12:00:30.000Z")).length, 0);
    assert.equal((await database.store.listPendingDeliveries("2026-09-08T12:01:00.000Z")).length, 1);
    await database.store.markDeliveryDelivered("delivery-retry", "2026-09-08T12:01:01.000Z", { transport: "discord", messageId: "m" });
    database.store.close();
    const reopened = new SQLiteExecutionStore(database.filename);
    const saved = await reopened.getDeliveryIntent("delivery-retry");
    assert.equal(saved?.attempts, 1);
    assert.deepEqual(saved?.deliveryEvidence, { transport: "discord", messageId: "m" });
    reopened.close();
  } finally { database.cleanup(); }
});
