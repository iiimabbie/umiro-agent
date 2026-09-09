import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ApprovalService,
  capabilities,
  ToolRegistry,
  ToolRuntime,
  type ExecutionContext,
  type Run,
  type Step,
  type ToolDefinition,
} from "@umiro/core";
import { SQLiteExecutionStore } from "../src/index.js";

const at = "2026-09-08T12:00:00.000Z";

function context(granted: readonly string[] = ["test.echo"]): ExecutionContext {
  return {
    actor: { id: "owner", kind: "human", roles: ["owner"] },
    origin: { kind: "interactive", transport: "discord", conversationId: "conversation-1" },
    authority: {
      capabilities: capabilities(...granted),
      visibility: { kind: "all" },
      instructionAuthority: "full",
    },
  };
}

function run(execution: ExecutionContext): Run {
  return {
    id: "run-1",
    revision: 0,
    state: "queued",
    context: execution,
    resumeEligibility: "not_applicable",
    createdAt: at,
    updatedAt: at,
  };
}

const step: Step = {
  id: "step-1",
  runId: "run-1",
  revision: 0,
  sequence: 0,
  kind: "operation",
  state: "pending",
  createdAt: at,
  updatedAt: at,
};

function echoTool(execute: ToolDefinition["execute"]): ToolDefinition {
  return {
    name: "test.echo",
    description: "Echo a string",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", minLength: 1 } },
      required: ["text"],
      additionalProperties: false,
    },
    policy: { capability: "test.echo", tier: "common", interactionRequirement: "not_required", sideEffect: "none", timeoutMs: 25 },
    execute,
  };
}

function fixture(granted?: readonly string[], tool?: ToolDefinition, executionOverride?: ExecutionContext) {
  const directory = mkdtempSync(join(tmpdir(), "umiro-tool-runtime-"));
  const store = new SQLiteExecutionStore(join(directory, "execution.db"));
  const execution = executionOverride ?? context(granted);
  const registry = new ToolRegistry();
  registry.register(tool ?? echoTool(async input => ({ ok: true, output: input, effectStatus: "not_applicable" })));
  let operationNumber = 0;
  let authorizationNumber = 0;
  let approvalNumber = 0;
  const runtime = new ToolRuntime(registry, store, {
    now: () => at,
    createId: kind => kind === "operation" ? `operation-${++operationNumber}` : kind === "authorization" ? `authorization-${++authorizationNumber}` : `approval-${++approvalNumber}`,
  });
  return {
    store,
    execution,
    registry,
    runtime,
    async initialize() { await store.createRunWithStep(run(execution), step); },
    cleanup() { store.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

test("registry validates schemas, names, duplicates, and model definitions", () => {
  const registry = new ToolRegistry();
  const tool = echoTool(async input => ({ ok: true, output: input, effectStatus: "not_applicable" }));
  registry.register(tool);
  assert.deepEqual(registry.validateInput(tool.name, { text: "hello" }), { valid: true, errors: [] });
  assert.equal(registry.validateInput(tool.name, { text: 1 }).valid, false);
  assert.deepEqual(registry.modelDefinitions(), [{ name: tool.name, description: tool.description, parameters: tool.inputSchema }]);
  assert.throws(() => registry.register(tool), /duplicate tool registration/);
  assert.throws(() => registry.register({ ...tool, name: "BAD NAME" }), /invalid tool name/);
});

test("persists authorization and executing state before calling the executor", async () => {
  let fixtureRef: ReturnType<typeof fixture>;
  const database = fixture(undefined, echoTool(async (input, execution) => {
    const persisted = await fixtureRef.store.getOperation(execution.operationId);
    assert.equal(persisted?.state, "executing");
    assert.deepEqual(persisted?.input, input);
    return { ok: true, output: { echoed: input.text ?? null }, effectStatus: "not_applicable" };
  }));
  fixtureRef = database;
  try {
    await database.initialize();
    const result = await database.runtime.execute({
      toolName: "test.echo",
      input: { text: "hello" },
      stepId: step.id,
      context: database.execution,
    });
    assert.deepEqual(result, { status: "succeeded", operationId: "operation-1", output: { echoed: "hello" } });
    assert.equal((await database.store.getOperation("operation-1"))?.state, "succeeded");
    assert.deepEqual((await database.store.getOperationResult("operation-1"))?.output, { echoed: "hello" });
  } finally {
    database.cleanup();
  }
});

test("invalid input creates no operation and denied input never reaches executor", async () => {
  let calls = 0;
  const database = fixture([], echoTool(async () => {
    calls += 1;
    return { ok: true, output: null, effectStatus: "not_applicable" };
  }));
  try {
    await database.initialize();
    const invalid = await database.runtime.execute({
      toolName: "test.echo",
      input: { text: 1 },
      stepId: step.id,
      context: database.execution,
    });
    assert.equal(invalid.status, "invalid_input");
    assert.equal(await database.store.getOperation("operation-1"), undefined);

    const denied = await database.runtime.execute({
      toolName: "test.echo",
      input: { text: "hello" },
      stepId: step.id,
      context: database.execution,
    });
    assert.equal(denied.status, "denied");
    assert.equal((await database.store.getOperation("operation-1"))?.state, "denied");
    assert.equal((await database.store.getAuthorizationDecision("authorization-1"))?.allow, false);
    assert.equal(calls, 0);
  } finally {
    database.cleanup();
  }
});

test("times out a pure tool as failed", async () => {
  const database = fixture(undefined, echoTool(async (_input, execution) => {
    await new Promise<void>(resolve => execution.signal.addEventListener("abort", () => resolve(), { once: true }));
    throw execution.signal.reason;
  }));
  try {
    await database.initialize();
    const result = await database.runtime.execute({
      toolName: "test.echo",
      input: { text: "slow" },
      stepId: step.id,
      context: database.execution,
    });
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, "tool_timeout");
    assert.equal((await database.store.getOperationResult("operation-1"))?.effectStatus, "not_applicable");
  } finally {
    database.cleanup();
  }
});

test("passes and persists the idempotency key for a mutating tool", async () => {
  let observedKey: string | undefined;
  const mutation: ToolDefinition = {
    ...echoTool(async (input, execution) => {
      observedKey = execution.idempotencyKey;
      return { ok: true, output: input, effectStatus: "confirmed" };
    }),
    policy: { capability: "test.echo", tier: "common", interactionRequirement: "not_required", sideEffect: "idempotent" },
  };
  const database = fixture(undefined, mutation);
  try {
    await database.initialize();
    const result = await database.runtime.execute({
      toolName: "test.echo",
      input: { text: "write once" },
      stepId: step.id,
      context: database.execution,
      idempotencyKey: "run-1:step-1:call-1",
    });
    assert.equal(result.status, "succeeded");
    assert.equal(observedKey, "run-1:step-1:call-1");
    assert.equal((await database.store.getOperation("operation-1"))?.idempotencyKey, "run-1:step-1:call-1");
  } finally {
    database.cleanup();
  }
});

test("projects a completed operation when an idempotency key is repeated", async () => {
  let calls = 0;
  const mutation: ToolDefinition = {
    ...echoTool(async input => {
      calls += 1;
      return { ok: true, output: input, effectStatus: "confirmed" };
    }),
    policy: { capability: "test.echo", tier: "common", interactionRequirement: "not_required", sideEffect: "idempotent" },
  };
  const database = fixture(undefined, mutation);
  const invocation = {
    toolName: "test.echo",
    input: { text: "write once" },
    stepId: step.id,
    context: database.execution,
    idempotencyKey: "run-1:step-1:call-1",
  } as const;
  try {
    await database.initialize();
    const first = await database.runtime.execute(invocation);
    const second = await database.runtime.execute(invocation);
    assert.deepEqual(second, first);
    assert.equal(calls, 1);
    assert.equal((await database.store.listAuditEvents("run-1")).filter(event => event.kind === "operation.authorization_decided").length, 1);
  } finally {
    database.cleanup();
  }
});

test("retries an unknown idempotent outcome on the same operation", async () => {
  let calls = 0;
  const mutation: ToolDefinition = {
    ...echoTool(async input => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: false,
          error: { code: "confirmation_lost", message: "confirmation was lost", retryable: true },
          effectStatus: "unknown",
        };
      }
      return { ok: true, output: input, effectStatus: "confirmed" };
    }),
    policy: { capability: "test.echo", tier: "common", interactionRequirement: "not_required", sideEffect: "idempotent" },
  };
  const database = fixture(undefined, mutation);
  const invocation = {
    toolName: "test.echo",
    input: { text: "confirm write" },
    stepId: step.id,
    context: database.execution,
    idempotencyKey: "run-1:step-1:call-1",
  } as const;
  try {
    await database.initialize();
    const first = await database.runtime.execute(invocation);
    const second = await database.runtime.execute(invocation);
    assert.equal(first.status, "outcome_unknown");
    assert.deepEqual(second, { status: "succeeded", operationId: "operation-1", output: { text: "confirm write" } });
    assert.equal(calls, 2);
    assert.equal((await database.store.getOperation("operation-1"))?.state, "succeeded");
    assert.equal((await database.store.getOperationResult("operation-1"))?.outcome, "succeeded");
  } finally {
    database.cleanup();
  }
});

test("allows a scheduled owner to execute a privileged automation-safe tool", async () => {
  let calls = 0;
  const scheduled: ExecutionContext = {
    ...context(["maintenance.run"]),
    origin: { kind: "schedule", scheduleId: "maintenance-1" },
  };
  const maintenance: ToolDefinition = {
    ...echoTool(async input => {
      calls += 1;
      return { ok: true, output: input, effectStatus: "not_applicable" };
    }),
    policy: {
      capability: "maintenance.run",
      tier: "privileged",
      interactionRequirement: "not_required",
      sideEffect: "none",
    },
  };
  const database = fixture(undefined, maintenance, scheduled);
  try {
    await database.initialize();
    const result = await database.runtime.execute({
      toolName: "test.echo",
      input: { text: "scheduled" },
      stepId: step.id,
      context: scheduled,
    });
    assert.equal(result.status, "succeeded");
    assert.equal(calls, 1);
  } finally {
    database.cleanup();
  }
});

test("denies a scheduled tool that explicitly requires live interaction", async () => {
  let calls = 0;
  const scheduled: ExecutionContext = {
    ...context(["maintenance.run"]),
    origin: { kind: "schedule", scheduleId: "maintenance-1" },
  };
  const interactiveOnly: ToolDefinition = {
    ...echoTool(async input => {
      calls += 1;
      return { ok: true, output: input, effectStatus: "not_applicable" };
    }),
    policy: {
      capability: "maintenance.run",
      tier: "privileged",
      interactionRequirement: "interactive_required",
      sideEffect: "none",
    },
  };
  const database = fixture(undefined, interactiveOnly, scheduled);
  try {
    await database.initialize();
    const result = await database.runtime.execute({
      toolName: "test.echo",
      input: { text: "scheduled" },
      stepId: step.id,
      context: scheduled,
    });
    assert.equal(result.status, "denied");
    assert.equal(result.error.message, "interactive_origin_required");
    assert.equal(calls, 0);
  } finally {
    database.cleanup();
  }
});

test("approved operations are reauthorized before atomic consumption", async () => {
  let calls = 0;
  const approvalTool: ToolDefinition = {
    ...echoTool(async input => { calls += 1; return { ok: true, output: input, effectStatus: "not_applicable" }; }),
    policy: { capability: "test.echo", tier: "common", interactionRequirement: "not_required", approvalRequirement: "required", sideEffect: "none" },
  };
  const database = fixture(undefined, approvalTool);
  try {
    await database.initialize();
    const invocation = { toolName: "test.echo", input: { text: "approved" }, stepId: step.id, context: database.execution };
    const waiting = await database.runtime.execute(invocation);
    assert.deepEqual(waiting, { status: "approval_required", operationId: "operation-1", approvalId: "approval-1", expiresAt: "2026-09-08T12:05:00.000Z" });
    await new ApprovalService(database.store, () => "2026-09-08T12:01:00.000Z").resolve("approval-1", "approve", database.execution);
    const revoked = { ...database.execution, authority: { ...database.execution.authority, capabilities: [] } };
    const result = await database.runtime.resume("operation-1", { ...invocation, context: revoked });
    assert.equal(result.status, "failed");
    if (result.status === "failed") assert.equal(result.error.code, "approval_revalidation_failed");
    assert.equal(calls, 0);
    assert.equal((await database.store.getApproval("approval-1"))?.state, "approved");
    assert.equal((await database.store.getOperation("operation-1"))?.state, "failed");
  } finally { database.cleanup(); }
});

test("persists pre-execution cancellation without calling the tool", async () => {
  let calls = 0;
  const database = fixture(undefined, echoTool(async input => {
    calls += 1;
    return { ok: true, output: input, effectStatus: "not_applicable" };
  }));
  const controller = new AbortController();
  controller.abort(new Error("cancelled by caller"));
  try {
    await database.initialize();
    const result = await database.runtime.execute({
      toolName: "test.echo",
      input: { text: "cancel" },
      stepId: step.id,
      context: database.execution,
      signal: controller.signal,
    });
    assert.equal(result.status, "cancelled");
    assert.equal(calls, 0);
    assert.equal((await database.store.getOperation("operation-1"))?.state, "cancelled");
  } finally {
    database.cleanup();
  }
});

test("times out a non-idempotent tool as outcome_unknown", async () => {
  const mutation: ToolDefinition = {
    ...echoTool(async (_input, execution) => {
      await new Promise<void>(resolve => execution.signal.addEventListener("abort", () => resolve(), { once: true }));
      throw execution.signal.reason;
    }),
    policy: { capability: "test.echo", tier: "common", interactionRequirement: "not_required", sideEffect: "non_idempotent", timeoutMs: 25 },
  };
  const database = fixture(undefined, mutation);
  try {
    await database.initialize();
    const result = await database.runtime.execute({
      toolName: "test.echo",
      input: { text: "mutate" },
      stepId: step.id,
      context: database.execution,
    });
    assert.equal(result.status, "outcome_unknown");
    assert.equal((await database.store.getOperation("operation-1"))?.state, "outcome_unknown");
    assert.equal((await database.store.getOperationResult("operation-1"))?.effectStatus, "unknown");
  } finally {
    database.cleanup();
  }
});

test("treats a mutating tool contract violation as outcome_unknown", async () => {
  let externalEffect = false;
  const mutation: ToolDefinition = {
    ...echoTool(async () => {
      externalEffect = true;
      return { ok: true, output: { written: true }, effectStatus: "not_applicable" };
    }),
    policy: { capability: "test.echo", tier: "common", interactionRequirement: "not_required", sideEffect: "idempotent" },
  };
  const database = fixture(undefined, mutation);
  try {
    await database.initialize();
    const result = await database.runtime.execute({
      toolName: "test.echo",
      input: { text: "mutate" },
      stepId: step.id,
      context: database.execution,
      idempotencyKey: "run-1:step-1:call-1",
    });
    assert.equal(externalEffect, true);
    assert.equal(result.status, "outcome_unknown");
    assert.equal(result.error.code, "tool_contract_violation");
    assert.equal((await database.store.getOperationResult("operation-1"))?.effectStatus, "unknown");
  } finally {
    database.cleanup();
  }
});
