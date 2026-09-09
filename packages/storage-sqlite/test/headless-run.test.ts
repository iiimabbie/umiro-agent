import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ApprovalRunCoordinator,
  capabilities,
  HeadlessRunEngine,
  ToolRegistry,
  type ExecutionContext,
  type ModelPort,
  type ModelResponse,
} from "@umiro/core";
import { SQLiteExecutionStore } from "../src/index.js";

const at = "2026-09-08T12:00:00.000Z";
const usage = { inputTokens: 10, outputTokens: 2, reasoningTokens: 0 };

function response(values: Partial<ModelResponse>): ModelResponse {
  return {
    text: "",
    toolCalls: [],
    finishReason: "stop",
    usage,
    assistantMessage: { role: "assistant", content: null },
    ...values,
  };
}

function ownerContext(...granted: string[]): ExecutionContext {
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

function deterministicIds() {
  const counters = new Map<string, number>();
  return (kind: "run" | "step" | "model_call" | "output" | "delivery" | "operation" | "authorization" | "approval") => {
    const next = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, next);
    return `${kind}-${next}`;
  };
}

test("runs model to tool to model and persists the final output", async () => {
  const directory = mkdtempSync(join(tmpdir(), "umiro-headless-run-"));
  const store = new SQLiteExecutionStore(join(directory, "execution.db"));
  const calls: Parameters<ModelPort["generate"]>[0][] = [];
  const model: ModelPort = {
    async generate(request) {
      calls.push(request);
      if (calls.length === 1) {
        const toolCall = { id: "call-1", name: "test.echo", input: { text: "hello" } };
        return response({
          toolCalls: [toolCall],
          finishReason: "tool_calls",
          assistantMessage: { role: "assistant", content: null, toolCalls: [toolCall] },
        });
      }
      assert.deepEqual(request.messages.at(-1), {
        role: "tool",
        toolCallId: "call-1",
        content: JSON.stringify({ ok: true, output: { echoed: "hello" } }),
      });
      return response({
        text: "done",
        assistantMessage: { role: "assistant", content: "done" },
      });
    },
  };
  const registry = new ToolRegistry();
  registry.register({
    name: "test.echo",
    description: "Echo text",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
    policy: {
      capability: "test.echo",
      tier: "common",
      interactionRequirement: "not_required",
      sideEffect: "none",
    },
    async execute(input) {
      return { ok: true, output: { echoed: input.text ?? null }, effectStatus: "not_applicable" };
    },
  });
  const createId = deterministicIds();
  const context = ownerContext("test.echo");
  try {
    const engine = new HeadlessRunEngine(model, registry, store, { now: () => at, createId });
    const result = await engine.run({ context, model: "fake-model", prompt: "echo hello" });
    assert.deepEqual(result, {
      status: "succeeded",
      runId: "run-1",
      deliveryId: "delivery-1",
      text: "done",
      usage: { inputTokens: 20, outputTokens: 4, reasoningTokens: 0 },
    });
    assert.equal(calls.length, 2);
    assert.equal((await store.getRun("run-1"))?.state, "succeeded");
    assert.equal((await store.getOperation("operation-1"))?.state, "succeeded");
    assert.equal((await store.listModelCalls("run-1")).length, 2);
    assert.deepEqual(await store.getRunOutput("run-1"), {
      id: "output-1",
      runId: "run-1",
      text: "done",
      usage: { inputTokens: 20, outputTokens: 4, reasoningTokens: 0 },
      createdAt: at,
    });
    assert.equal(await store.getCheckpoint("run-1"), undefined);
    assert.deepEqual(await store.getDeliveryIntent("delivery-1"), {
      id: "delivery-1",
      runId: "run-1",
      destination: { kind: "caller" },
      payload: { text: "done" },
      state: "pending",
      createdAt: at,
    });
    assert.deepEqual((await store.listPendingDeliveries()).map(delivery => delivery.id), ["delivery-1"]);
    await store.markDeliveryDelivered("delivery-1", at);
    assert.equal((await store.getDeliveryIntent("delivery-1"))?.state, "delivered");
    assert.deepEqual(await store.listPendingDeliveries(), []);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("returns malformed model tool arguments to the model without executing them", async () => {
  const directory = mkdtempSync(join(tmpdir(), "umiro-headless-invalid-tool-"));
  const store = new SQLiteExecutionStore(join(directory, "execution.db"));
  let modelCalls = 0;
  let toolCalls = 0;
  const model: ModelPort = {
    async generate(request) {
      modelCalls += 1;
      if (modelCalls === 1) {
        const toolCall = {
          id: "call-1",
          name: "test.echo",
          input: {},
          argumentError: "arguments are not valid JSON",
        };
        return response({
          toolCalls: [toolCall],
          finishReason: "tool_calls",
          assistantMessage: { role: "assistant", content: null, toolCalls: [toolCall] },
        });
      }
      assert.match(String(request.messages.at(-1)?.content), /malformed_tool_arguments/);
      return response({ text: "recovered", assistantMessage: { role: "assistant", content: "recovered" } });
    },
  };
  const registry = new ToolRegistry();
  registry.register({
    name: "test.echo",
    description: "Echo text",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    policy: { capability: "test.echo", tier: "common", interactionRequirement: "not_required", sideEffect: "none" },
    async execute() {
      toolCalls += 1;
      return { ok: true, output: null, effectStatus: "not_applicable" };
    },
  });
  try {
    const engine = new HeadlessRunEngine(model, registry, store, { now: () => at, createId: deterministicIds() });
    const result = await engine.run({ context: ownerContext("test.echo"), model: "fake-model", prompt: "bad arguments" });
    assert.equal(result.status, "succeeded");
    assert.equal(toolCalls, 0);
    assert.equal(await store.getOperation("operation-1"), undefined);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("fails a Run when the model exceeds input or output token ceilings", async (context) => {
  for (const scenario of [
    { name: "input", usage: { inputTokens: 6, outputTokens: 1, reasoningTokens: 0 }, request: { maxInputTokens: 5 }, error: /input token budget exceeded: 5/ },
    { name: "output", usage: { inputTokens: 1, outputTokens: 6, reasoningTokens: 0 }, request: { maxOutputTokens: 5 }, error: /output token budget exceeded: 5/ },
  ] as const) {
    await context.test(scenario.name, async () => {
      const store = new SQLiteExecutionStore(":memory:");
      let requestedOutput: number | undefined;
      const model: ModelPort = { async generate(request) { requestedOutput = request.maxOutputTokens; return response({ text: "too much", usage: scenario.usage, assistantMessage: { role: "assistant", content: "too much" } }); } };
      try {
        const engine = new HeadlessRunEngine(model, new ToolRegistry(), store, { now: () => at, createId: deterministicIds() });
        const result = await engine.run({ context: ownerContext(), model: "fake-model", prompt: "bounded", ...scenario.request });
        assert.equal(result.status, "failed");
        if (result.status === "failed") assert.match(result.error, scenario.error);
        if (scenario.name === "output") assert.equal(requestedOutput, 5);
        assert.equal((await store.getRun("run-1"))?.state, "failed");
        assert.equal((await store.listModelCalls("run-1")).length, 1);
      } finally { store.close(); }
    });
  }
});

test("does not execute tool calls beyond the Run ceiling", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  let executed = 0;
  const calls = [
    { id: "call-1", name: "test.count", input: {} },
    { id: "call-2", name: "test.count", input: {} },
  ];
  const model: ModelPort = { async generate() { return response({ toolCalls: calls, finishReason: "tool_calls", assistantMessage: { role: "assistant", content: null, toolCalls: calls } }); } };
  const registry = new ToolRegistry();
  registry.register({
    name: "test.count", description: "Count", inputSchema: { type: "object", properties: {}, additionalProperties: false },
    policy: { capability: "test.count", tier: "common", interactionRequirement: "not_required", sideEffect: "none" },
    async execute() { executed += 1; return { ok: true, output: null, effectStatus: "not_applicable" }; },
  });
  try {
    const engine = new HeadlessRunEngine(model, registry, store, { now: () => at, createId: deterministicIds() });
    const result = await engine.run({ context: ownerContext("test.count"), model: "fake-model", prompt: "two calls", maxToolCalls: 1 });
    assert.equal(result.status, "failed");
    if (result.status === "failed") assert.match(result.error, /tool call budget exceeded: 1/);
    assert.equal(executed, 1);
  } finally { store.close(); }
});

test("waits for exact approval and resumes the same operation cursor after atomic consumption", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  let modelCalls = 0; let toolCalls = 0;
  const model: ModelPort = {
    async generate(request) {
      modelCalls += 1;
      if (modelCalls === 1) {
        const toolCall = { id: "call-approval", name: "test.approved", input: { target: "one" } };
        return response({ toolCalls: [toolCall], finishReason: "tool_calls", assistantMessage: { role: "assistant", content: null, toolCalls: [toolCall] } });
      }
      assert.match(String(request.messages.at(-1)?.content), /"ok":true/);
      return response({ text: "approved and done", assistantMessage: { role: "assistant", content: "approved and done" } });
    },
  };
  const registry = new ToolRegistry();
  registry.register({
    name: "test.approved", description: "Approved action", inputSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"], additionalProperties: false },
    policy: { capability: "test.approved", tier: "privileged", interactionRequirement: "interactive_required", approvalRequirement: "required", sideEffect: "none" },
    async execute() { toolCalls += 1; return { ok: true, output: { changed: true }, effectStatus: "not_applicable" }; },
  });
  try {
    const engine = new HeadlessRunEngine(model, registry, store, { now: () => at, createId: deterministicIds() });
    const waiting = await engine.run({ context: ownerContext("test.approved"), model: "fake-model", prompt: "do approved action" });
    assert.deepEqual(waiting, { status: "waiting", runId: "run-1", reason: "approval_required", approvalId: "approval-1" });
    assert.equal(toolCalls, 0);
    assert.equal((await store.getRun("run-1"))?.resumeEligibility, "manual_review");

    const coordinator = new ApprovalRunCoordinator(store, engine, () => at);
    const resumed = await coordinator.resolveAndResume("approval-1", "approve", ownerContext("test.approved"));
    assert.equal(resumed.status, "resumed");
    if (resumed.status === "resumed") assert.deepEqual(resumed.result, { status: "succeeded", runId: "run-1", deliveryId: "delivery-1", text: "approved and done", usage: { inputTokens: 20, outputTokens: 4, reasoningTokens: 0 } });
    assert.equal(toolCalls, 1);
    assert.equal((await store.getApproval("approval-1"))?.state, "consumed");
    assert.equal((await store.getOperation("operation-1"))?.state, "succeeded");
  } finally { store.close(); }
});

test("aborts an in-flight model call at the Run duration ceiling", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  const model: ModelPort = {
    async generate(request) {
      return await new Promise<ModelResponse>((_resolve, reject) => {
        const fail = () => reject(request.signal?.reason ?? new Error("aborted"));
        if (request.signal?.aborted) fail(); else request.signal?.addEventListener("abort", fail, { once: true });
      });
    },
  };
  try {
    const engine = new HeadlessRunEngine(model, new ToolRegistry(), store, { now: () => at, createId: deterministicIds() });
    const result = await engine.run({ context: ownerContext(), model: "fake-model", prompt: "wait", maxDurationMs: 20 });
    assert.equal(result.status, "failed");
    if (result.status === "failed") assert.match(result.error, /run duration budget exceeded: 20ms/);
  } finally { store.close(); }
});

test("rejects invalid Run ceilings before creating durable state", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  const model: ModelPort = { async generate() { return response({ text: "unused" }); } };
  try {
    const engine = new HeadlessRunEngine(model, new ToolRegistry(), store, { now: () => at, createId: deterministicIds() });
    await assert.rejects(engine.run({ context: ownerContext(), model: "fake-model", prompt: "invalid", maxToolCalls: 0 }), /maxToolCalls must be a positive safe integer/);
    assert.equal(await store.getRun("run-1"), undefined);
  } finally { store.close(); }
});

test("waits for manual review when a non-idempotent effect is unknown", async () => {
  const directory = mkdtempSync(join(tmpdir(), "umiro-headless-unknown-tool-"));
  const store = new SQLiteExecutionStore(join(directory, "execution.db"));
  const model: ModelPort = {
    async generate() {
      const toolCall = { id: "call-1", name: "test.mutate", input: {} };
      return response({
        toolCalls: [toolCall],
        finishReason: "tool_calls",
        assistantMessage: { role: "assistant", content: null, toolCalls: [toolCall] },
      });
    },
  };
  const registry = new ToolRegistry();
  registry.register({
    name: "test.mutate",
    description: "Mutate once",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    policy: { capability: "test.mutate", tier: "common", interactionRequirement: "not_required", sideEffect: "non_idempotent" },
    async execute() {
      return {
        ok: false,
        error: { code: "confirmation_lost", message: "confirmation was lost", retryable: false },
        effectStatus: "unknown",
      };
    },
  });
  try {
    const engine = new HeadlessRunEngine(model, registry, store, { now: () => at, createId: deterministicIds() });
    const result = await engine.run({ context: ownerContext("test.mutate"), model: "fake-model", prompt: "mutate" });
    assert.deepEqual(result, { status: "waiting", runId: "run-1", reason: "outcome_unknown" });
    assert.equal((await store.getRun("run-1"))?.resumeEligibility, "manual_review");
    assert.equal((await store.getOperation("operation-1"))?.state, "outcome_unknown");
    assert.ok(await store.getCheckpoint("run-1"));
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
