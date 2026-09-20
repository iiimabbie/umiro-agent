import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  authorize,
  capabilities,
  HeadlessRunEngine,
  HeadlessRecoveryCoordinator,
  StartupRecovery,
  RunNotRecoverableError,
  ToolRegistry,
  type AuthorizationDecisionRecord,
  type ExecutionContext,
  type Operation,
  type Run,
  type ModelPort,
  type SideEffectClass,
  type Step,
  type ToolDefinition,
} from "@umiro/core";
import { SQLiteExecutionStore } from "../src/index.js";

const at = "2026-09-09T01:00:00.000Z";
const recoveredAt = "2026-09-09T01:05:00.000Z";

const context: ExecutionContext = {
  actor: { id: "owner", kind: "human", roles: ["owner"] },
  origin: { kind: "event", pluginId: "recovery-test" },
  authority: {
    capabilities: capabilities("test.recover"),
    visibility: { kind: "all" },
    instructionAuthority: "full",
  },
};

async function createExecutingOperation(
  store: SQLiteExecutionStore,
  suffix: string,
  sideEffect: SideEffectClass,
): Promise<Operation> {
  const runId = `run-${suffix}`;
  const stepId = `step-${suffix}`;
  const run: Run = {
    id: runId,
    revision: 0,
    state: "queued",
    context,
    resumeEligibility: "eligible",
    createdAt: at,
    updatedAt: at,
  };
  const step: Step = {
    id: stepId,
    runId,
    revision: 0,
    sequence: 0,
    kind: "operation",
    state: "pending",
    createdAt: at,
    updatedAt: at,
  };
  await store.createRunWithStep(run, step);
  await store.updateExecutionProgress({
    runId,
    expectedRunRevision: 0,
    expectedRunState: "queued",
    runState: "running",
    resumeEligibility: "eligible",
    runUpdatedAt: at,
    step: { id: stepId, expectedRevision: 0, expectedState: "pending", state: "running", updatedAt: at },
    checkpoint: { runId, version: 1, data: { messages: [] }, updatedAt: at },
  });
  const operationId = `operation-${suffix}`;
  const baseDecision = authorize({ context, capability: "test.recover", tier: "common" });
  const decision: AuthorizationDecisionRecord = {
    ...baseDecision,
    id: `authorization-${suffix}`,
    operationId,
    decidedAt: at,
  };
  const operation: Operation = {
    id: operationId,
    stepId,
    kind: "tool:test.recover",
    input: { suffix },
    state: "authorized",
    capability: "test.recover",
    authorizationTier: "common",
    sideEffect,
    ...(sideEffect === "idempotent" ? { idempotencyKey: `key-${suffix}` } : {}),
    authorizationDecisionId: decision.id,
    createdAt: at,
    updatedAt: at,
  };
  await store.recordOperationAuthorization(operation, decision);
  await store.markOperationExecuting(operation.id, at);
  return operation;
}

test("startup recovery classifies interrupted external effects after reopening SQLite", async () => {
  const directory = mkdtempSync(join(tmpdir(), "umiro-startup-recovery-"));
  const filename = join(directory, "execution.db");
  const beforeCrash = new SQLiteExecutionStore(filename);
  try {
    await createExecutingOperation(beforeCrash, "pure", "none");
    await createExecutingOperation(beforeCrash, "idempotent", "idempotent");
    await createExecutingOperation(beforeCrash, "unsafe", "non_idempotent");
    beforeCrash.close();

    const afterRestart = new SQLiteExecutionStore(filename);
    try {
      const recovery = new StartupRecovery(afterRestart, { now: () => recoveredAt });
      const candidates = await recovery.prepare();
      assert.deepEqual(candidates, [
        { runId: "run-idempotent", disposition: "resume", interruptedOperationIds: ["operation-idempotent"] },
        { runId: "run-pure", disposition: "resume", interruptedOperationIds: ["operation-pure"] },
        { runId: "run-unsafe", disposition: "manual_review", interruptedOperationIds: ["operation-unsafe"] },
      ]);

      assert.deepEqual(await afterRestart.getOperationResult("operation-pure"), {
        operationId: "operation-pure",
        outcome: "failed",
        effectStatus: "not_applicable",
        error: {
          code: "process_interrupted",
          message: "the process exited while the operation was executing",
          retryable: true,
        },
        completedAt: recoveredAt,
      });
      assert.equal((await afterRestart.getOperation("operation-idempotent"))?.state, "outcome_unknown");
      assert.equal((await afterRestart.getOperationResult("operation-idempotent"))?.effectStatus, "unknown");
      assert.deepEqual(
        [await afterRestart.getRun("run-pure"), await afterRestart.getRun("run-idempotent")].map(run => ({
          state: run?.state,
          eligibility: run?.resumeEligibility,
          interruption: run?.interruption?.kind,
        })),
        [
          { state: "waiting", eligibility: "eligible", interruption: "process_exit" },
          { state: "waiting", eligibility: "eligible", interruption: "process_exit" },
        ],
      );
      assert.equal((await afterRestart.getOperationResult("operation-unsafe"))?.error?.retryable, false);
      assert.deepEqual(
        {
          state: (await afterRestart.getRun("run-unsafe"))?.state,
          eligibility: (await afterRestart.getRun("run-unsafe"))?.resumeEligibility,
          step: (await afterRestart.getStep("step-unsafe"))?.state,
          checkpoint: (await afterRestart.getCheckpoint("run-unsafe"))?.version,
        },
        { state: "waiting", eligibility: "manual_review", step: "failed", checkpoint: 1 },
      );

      const claim = await recovery.claim("run-idempotent");
      assert.equal(claim.run.state, "running");
      assert.equal(claim.run.interruption, undefined);
      assert.equal(claim.checkpoint.version, 1);
      assert.deepEqual(claim.operations.map(operation => operation.id), ["operation-idempotent"]);
      await assert.rejects(recovery.claim("run-idempotent"), RunNotRecoverableError);
      await assert.rejects(recovery.claim("run-unsafe"), RunNotRecoverableError);
    } finally {
      afterRestart.close();
    }
  } finally {
    try { beforeCrash.close(); } catch { /* already closed */ }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("startup coordinator resumes a model cursor from its durable checkpoint", async () => {
  const directory = mkdtempSync(join(tmpdir(), "umiro-model-resume-"));
  const filename = join(directory, "execution.db");
  const beforeCrash = new SQLiteExecutionStore(filename);
  const run: Run = {
    id: "run-resume",
    revision: 0,
    state: "queued",
    context,
    resumeEligibility: "eligible",
    createdAt: at,
    updatedAt: at,
  };
  const step: Step = {
    id: "step-resume",
    runId: run.id,
    revision: 0,
    sequence: 0,
    kind: "model_call",
    state: "pending",
    createdAt: at,
    updatedAt: at,
  };
  try {
    await beforeCrash.createRunWithStep(run, step);
    await beforeCrash.updateExecutionProgress({
      runId: run.id,
      expectedRunRevision: 0,
      expectedRunState: "queued",
      runState: "running",
      resumeEligibility: "eligible",
      runUpdatedAt: at,
      step: { id: step.id, expectedRevision: 0, expectedState: "pending", state: "running", updatedAt: at },
      checkpoint: {
        runId: run.id,
        version: 1,
        data: {
          version: 2,
          model: "fake-model",
          messages: [{ role: "user", content: "resume me" }],
          usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
          visibleToolNames: ["test.visible"],
        },
        updatedAt: at,
      },
    });
    beforeCrash.close();

    const afterRestart = new SQLiteExecutionStore(filename);
    try {
      const requests: Parameters<ModelPort["generate"]>[0][] = [];
      const model: ModelPort = {
        async generate(request) {
          requests.push(structuredClone(request));
          assert.deepEqual(request.tools?.map(tool => tool.name), ["test.visible"]);
          return {
            text: "resumed",
            toolCalls: [],
            finishReason: "stop",
            usage: { inputTokens: 3, outputTokens: 1, reasoningTokens: 0 },
            assistantMessage: { role: "assistant", content: "resumed" },
          };
        },
      };
      let nextId = 0;
      const registry = new ToolRegistry();
      const tool = (name: string): ToolDefinition => ({ name, description: name, inputSchema: { type: "object", properties: {}, additionalProperties: false }, policy: { capability: "test.recover", tier: "common", interactionRequirement: "not_required", sideEffect: "none" }, async execute() { return { ok: true, output: null, effectStatus: "not_applicable" }; } });
      registry.register(tool("test.visible"));
      registry.register(tool("test.hidden"));
      const engine = new HeadlessRunEngine(model, registry, afterRestart, {
        now: () => recoveredAt,
        createId: kind => `${kind}-resume-${++nextId}`,
      });
      const coordinator = new HeadlessRecoveryCoordinator(afterRestart, engine, { now: () => recoveredAt });
      assert.deepEqual(await coordinator.recoverAll(), [{
        runId: run.id,
        status: "resumed",
        result: {
          status: "succeeded",
          runId: run.id,
          deliveryId: "delivery-resume-2",
          text: "resumed",
          usage: { inputTokens: 3, outputTokens: 1, reasoningTokens: 0 },
        },
      }]);
      assert.deepEqual(requests[0]?.messages, [{ role: "user", content: "resume me" }]);
      assert.equal((await afterRestart.getRun(run.id))?.state, "succeeded");
      assert.equal(await afterRestart.getCheckpoint(run.id), undefined);
      assert.equal((await afterRestart.listModelCalls(run.id)).length, 1);
    } finally {
      afterRestart.close();
    }
  } finally {
    try { beforeCrash.close(); } catch { /* already closed */ }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reconciles a durable final model response without calling the model again", async () => {
  const directory = mkdtempSync(join(tmpdir(), "umiro-model-result-resume-"));
  const filename = join(directory, "execution.db");
  const beforeCrash = new SQLiteExecutionStore(filename);
  const runId = "run-model-result";
  const stepId = "step-model-result";
  try {
    await beforeCrash.createRunWithStep({
      id: runId, revision: 0, state: "queued", context, resumeEligibility: "eligible", createdAt: at, updatedAt: at,
    }, {
      id: stepId, runId, revision: 0, sequence: 0, kind: "model_call", state: "pending", createdAt: at, updatedAt: at,
    });
    const messages = [{ role: "user" as const, content: "finish me" }];
    await beforeCrash.updateExecutionProgress({
      runId,
      expectedRunRevision: 0,
      expectedRunState: "queued",
      runState: "running",
      resumeEligibility: "eligible",
      runUpdatedAt: at,
      step: { id: stepId, expectedRevision: 0, expectedState: "pending", state: "running", updatedAt: at },
      checkpoint: {
        runId,
        version: 1,
        data: {
          version: 2,
          model: "fake-model",
          messages,
          usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
        },
        updatedAt: at,
      },
    });
    await beforeCrash.recordModelCall({
      id: "model-call-result",
      runId,
      stepId,
      model: "fake-model",
      messages,
      response: {
        text: "already durable",
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 3, outputTokens: 2, reasoningTokens: 0 },
        assistantMessage: { role: "assistant", content: "already durable" },
      },
      createdAt: at,
    });
    beforeCrash.close();

    const afterRestart = new SQLiteExecutionStore(filename);
    try {
      const recovery = new StartupRecovery(afterRestart, { now: () => recoveredAt });
      await recovery.prepare();
      const claim = await recovery.claim(runId);
      let modelCalls = 0;
      const model: ModelPort = {
        async generate() {
          modelCalls += 1;
          throw new Error("the durable response must be reused");
        },
      };
      let nextId = 0;
      const engine = new HeadlessRunEngine(model, new ToolRegistry(), afterRestart, {
        now: () => recoveredAt,
        createId: kind => `${kind}-model-result-${++nextId}`,
      });
      assert.deepEqual(await engine.resume(claim), {
        status: "succeeded",
        runId,
        deliveryId: "delivery-model-result-1",
        text: "already durable",
        usage: { inputTokens: 3, outputTokens: 2, reasoningTokens: 0 },
      });
      assert.equal(modelCalls, 0);
      assert.equal((await afterRestart.getRun(runId))?.state, "succeeded");
      assert.equal((await afterRestart.getRunOutput(runId))?.text, "already durable");
    } finally {
      afterRestart.close();
    }
  } finally {
    try { beforeCrash.close(); } catch { /* already closed */ }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("retries an interrupted idempotent tool and continues the same Run", async () => {
  const directory = mkdtempSync(join(tmpdir(), "umiro-tool-resume-"));
  const filename = join(directory, "execution.db");
  const beforeCrash = new SQLiteExecutionStore(filename);
  const runId = "run-tool-resume";
  const stepId = "step-tool-resume";
  try {
    const run: Run = {
      id: runId, revision: 0, state: "queued", context, resumeEligibility: "eligible", createdAt: at, updatedAt: at,
    };
    const step: Step = {
      id: stepId, runId, revision: 0, sequence: 0, kind: "operation", state: "pending", createdAt: at, updatedAt: at,
    };
    await beforeCrash.createRunWithStep(run, step);
    await beforeCrash.updateExecutionProgress({
      runId,
      expectedRunRevision: 0,
      expectedRunState: "queued",
      runState: "running",
      resumeEligibility: "eligible",
      runUpdatedAt: at,
      step: { id: stepId, expectedRevision: 0, expectedState: "pending", state: "running", updatedAt: at },
      checkpoint: {
        runId,
        version: 1,
        data: {
          version: 2,
          model: "fake-model",
          messages: [
            { role: "user", content: "write" },
            {
              role: "assistant",
              content: null,
              toolCalls: [{ id: "call-1", name: "test.recover", input: { value: "once" } }],
            },
          ],
          usage: { inputTokens: 2, outputTokens: 1, reasoningTokens: 0 },
        },
        updatedAt: at,
      },
    });
    const baseDecision = authorize({ context, capability: "test.recover", tier: "common" });
    const decision: AuthorizationDecisionRecord = {
      ...baseDecision,
      id: "authorization-tool-resume",
      operationId: "operation-tool-resume",
      decidedAt: at,
    };
    await beforeCrash.recordOperationAuthorization({
      id: "operation-tool-resume",
      stepId,
      kind: "tool:test.recover",
      input: { value: "once" },
      state: "authorized",
      capability: "test.recover",
      authorizationTier: "common",
      sideEffect: "idempotent",
      idempotencyKey: `${runId}:call-1`,
      authorizationDecisionId: decision.id,
      createdAt: at,
      updatedAt: at,
    }, decision);
    await beforeCrash.markOperationExecuting("operation-tool-resume", at);
    beforeCrash.close();

    const afterRestart = new SQLiteExecutionStore(filename);
    try {
      const recovery = new StartupRecovery(afterRestart, { now: () => recoveredAt });
      await recovery.prepare();
      const claim = await recovery.claim(runId);
      let toolCalls = 0;
      const tool: ToolDefinition = {
        name: "test.recover",
        description: "recover a write",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
        policy: {
          capability: "test.recover",
          tier: "common",
          interactionRequirement: "not_required",
          sideEffect: "idempotent",
        },
        async execute(input, execution) {
          toolCalls += 1;
          assert.equal(execution.idempotencyKey, `${runId}:call-1`);
          return { ok: true, output: input, effectStatus: "confirmed" };
        },
      };
      const registry = new ToolRegistry();
      registry.register(tool);
      const model: ModelPort = {
        async generate(request) {
          assert.equal(request.messages.at(-1)?.role, "tool");
          return {
            text: "write confirmed",
            toolCalls: [],
            finishReason: "stop",
            usage: { inputTokens: 4, outputTokens: 2, reasoningTokens: 0 },
            assistantMessage: { role: "assistant", content: "write confirmed" },
          };
        },
      };
      let nextId = 0;
      const engine = new HeadlessRunEngine(model, registry, afterRestart, {
        now: () => recoveredAt,
        createId: kind => `${kind}-tool-resume-${++nextId}`,
      });
      assert.deepEqual(await engine.resume(claim), {
        status: "succeeded",
        runId,
        deliveryId: "delivery-tool-resume-5",
        text: "write confirmed",
        usage: { inputTokens: 6, outputTokens: 3, reasoningTokens: 0 },
      });
      assert.equal(toolCalls, 1);
      assert.equal((await afterRestart.getOperation("operation-tool-resume"))?.state, "succeeded");
      assert.equal((await afterRestart.listOperations(runId)).length, 1);
    } finally {
      afterRestart.close();
    }
  } finally {
    try { beforeCrash.close(); } catch { /* already closed */ }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("continues from a durable tool result without executing the tool again", async () => {
  const directory = mkdtempSync(join(tmpdir(), "umiro-tool-result-resume-"));
  const filename = join(directory, "execution.db");
  const beforeCrash = new SQLiteExecutionStore(filename);
  const runId = "run-result-resume";
  const stepId = "step-result-resume";
  try {
    await beforeCrash.createRunWithStep({
      id: runId, revision: 0, state: "queued", context, resumeEligibility: "eligible", createdAt: at, updatedAt: at,
    }, {
      id: stepId, runId, revision: 0, sequence: 0, kind: "operation", state: "pending", createdAt: at, updatedAt: at,
    });
    await beforeCrash.updateExecutionProgress({
      runId,
      expectedRunRevision: 0,
      expectedRunState: "queued",
      runState: "running",
      resumeEligibility: "eligible",
      runUpdatedAt: at,
      step: { id: stepId, expectedRevision: 0, expectedState: "pending", state: "running", updatedAt: at },
      checkpoint: {
        runId,
        version: 1,
        data: {
          version: 2,
          model: "fake-model",
          messages: [
            { role: "user", content: "read" },
            { role: "assistant", content: null, toolCalls: [{ id: "call-1", name: "test.recover", input: {} }] },
          ],
          usage: { inputTokens: 2, outputTokens: 1, reasoningTokens: 0 },
        },
        updatedAt: at,
      },
    });
    const baseDecision = authorize({ context, capability: "test.recover", tier: "common" });
    const decision: AuthorizationDecisionRecord = {
      ...baseDecision,
      id: "authorization-result-resume",
      operationId: "operation-result-resume",
      decidedAt: at,
    };
    await beforeCrash.recordOperationAuthorization({
      id: "operation-result-resume",
      stepId,
      kind: "tool:test.recover",
      input: {},
      state: "authorized",
      capability: "test.recover",
      authorizationTier: "common",
      sideEffect: "none",
      authorizationDecisionId: decision.id,
      createdAt: at,
      updatedAt: at,
    }, decision);
    await beforeCrash.markOperationExecuting("operation-result-resume", at);
    await beforeCrash.recordOperationOutcome("operation-result-resume", {
      operationId: "operation-result-resume",
      outcome: "succeeded",
      effectStatus: "not_applicable",
      output: { durable: true },
      completedAt: at,
    }, at);
    beforeCrash.close();

    const afterRestart = new SQLiteExecutionStore(filename);
    try {
      const recovery = new StartupRecovery(afterRestart, { now: () => recoveredAt });
      await recovery.prepare();
      const claim = await recovery.claim(runId);
      let toolCalls = 0;
      const registry = new ToolRegistry();
      registry.register({
        name: "test.recover",
        description: "must not execute",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        policy: { capability: "test.recover", tier: "common", interactionRequirement: "not_required", sideEffect: "none" },
        async execute() {
          toolCalls += 1;
          return { ok: true, output: null, effectStatus: "not_applicable" };
        },
      });
      const model: ModelPort = {
        async generate(request) {
          const toolMessage = request.messages.at(-1);
          assert.equal(toolMessage?.role, "tool");
          assert.match(String(toolMessage?.content), /durable/);
          return {
            text: "used durable result",
            toolCalls: [],
            finishReason: "stop",
            usage: { inputTokens: 3, outputTokens: 2, reasoningTokens: 0 },
            assistantMessage: { role: "assistant", content: "used durable result" },
          };
        },
      };
      let nextId = 0;
      const engine = new HeadlessRunEngine(model, registry, afterRestart, {
        now: () => recoveredAt,
        createId: kind => `${kind}-result-resume-${++nextId}`,
      });
      assert.equal((await engine.resume(claim)).status, "succeeded");
      assert.equal(toolCalls, 0);
      assert.equal((await afterRestart.listOperations(runId)).length, 1);
    } finally {
      afterRestart.close();
    }
  } finally {
    try { beforeCrash.close(); } catch { /* already closed */ }
    rmSync(directory, { recursive: true, force: true });
  }
});
