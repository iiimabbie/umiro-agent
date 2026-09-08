import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
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
import { INITIAL_SCHEMA } from "../src/migrations/001-initial.js";

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

test("upgrades a version 1 database with pending delivery support", async () => {
  const directory = mkdtempSync(join(tmpdir(), "umiro-v1-migration-"));
  const filename = join(directory, "execution.db");
  const legacy = new Database(filename);
  try {
    legacy.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      ${INITIAL_SCHEMA}
      INSERT INTO schema_migrations(version, applied_at) VALUES (1, '${at}');
    `);
  } finally {
    legacy.close();
  }

  const store = new SQLiteExecutionStore(filename);
  try {
    await store.createRunWithStep(run(), step());
    await store.updateExecutionProgress({
      runId: "run-1",
      expectedRunRevision: 0,
      expectedRunState: "queued",
      runState: "running",
      resumeEligibility: "eligible",
      runUpdatedAt: at,
    });
    await store.completeRunWithOutput({
      output: {
        id: "output-v2",
        runId: "run-1",
        text: "migrated",
        usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 },
        createdAt: at,
      },
      delivery: {
        id: "delivery-v2",
        runId: "run-1",
        destination: { kind: "test" },
        payload: { text: "migrated" },
        state: "pending",
        createdAt: at,
      },
      expectedRunRevision: 1,
      runUpdatedAt: at,
    });
    assert.equal((await store.getDeliveryIntent("delivery-v2"))?.state, "pending");
    assert.ok((await store.listAuditEvents("run-1")).some(event => event.entityType === "delivery"));
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
