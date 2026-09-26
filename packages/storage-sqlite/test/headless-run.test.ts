import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  capabilities,
  estimateModelRequestTokens,
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
  return (kind: "run" | "step" | "model_call" | "output" | "delivery" | "operation" | "authorization") => {
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

test("injects model-only tool artifacts after the complete tool batch", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  const requests: Parameters<ModelPort["generate"]>[0][] = [];
  const model: ModelPort = { async generate(request) {
    requests.push(request);
    if (requests.length === 1) {
      const calls = [{ id: "media-a", name: "test.media", input: {} }, { id: "media-b", name: "test.media", input: {} }, { id: "media-c", name: "test.media", input: {} }];
      return response({ toolCalls: calls, finishReason: "tool_calls", assistantMessage: { role: "assistant", content: null, toolCalls: calls } });
    }
    assert.deepEqual(request.messages.slice(-4).map(message => message.role), ["tool", "tool", "tool", "user"], JSON.stringify(request.messages));
    const media = request.messages.at(-1)!;
    assert.equal(media.role, "user");
    assert.equal(typeof media.content, "object");
    const injected = typeof media.content === "string" ? undefined : media.content.at(-1);
    assert.equal(injected?.type, "text");
    assert.equal(injected?.type === "text" ? injected.text : undefined, "artifact-a,artifact-b");
    return response({ text: "saw it", assistantMessage: { role: "assistant", content: "saw it" } });
  } };
  const registry = new ToolRegistry();
  registry.register({ name: "test.media", description: "media", inputSchema: { type: "object", properties: {}, additionalProperties: false }, policy: { capability: "test.media", tier: "common", interactionRequirement: "not_required", sideEffect: "none", concurrency: "parallel_safe" }, async execute(_input, context) { return { ok: true, output: { loaded: true }, modelInputArtifactIds: context.operationId === "operation-1" ? ["artifact-a"] : ["artifact-b", "artifact-a"], effectStatus: "not_applicable" }; } });
  try {
    const result = await new HeadlessRunEngine(model, registry, store, { now: () => at, createId: deterministicIds(), maxParallelToolCalls: 2, resolveModelInputArtifacts: async ({ artifactIds }) => [{ type: "text", text: artifactIds.join(",") }] }).run({ context: ownerContext("test.media"), model: "fake", prompt: "inspect" });
    assert.equal(result.status, "succeeded");
    assert.deepEqual(await store.getRunOutput("run-1"), { id: "output-1", runId: "run-1", text: "saw it", usage: { inputTokens: 20, outputTokens: 4, reasoningTokens: 0 }, createdAt: at });
  } finally { store.close(); }
});

test("keeps analyzer-selected tools visible across model turns and rejects hidden hallucinations", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  let hiddenExecutions = 0;
  let modelCalls = 0;
  const model: ModelPort = { async generate(request) {
    modelCalls += 1;
    assert.deepEqual(request.tools?.map(tool => tool.name), ["test.visible"]);
    if (modelCalls === 1) {
      const toolCall = { id: "hidden-call", name: "test.hidden", input: {} };
      return response({ toolCalls: [toolCall], finishReason: "tool_calls", assistantMessage: { role: "assistant", content: null, toolCalls: [toolCall] } });
    }
    assert.match(String(request.messages.at(-1)?.content), /tool_not_found/);
    return response({ text: "hidden tool was rejected", assistantMessage: { role: "assistant", content: "hidden tool was rejected" } });
  } };
  const registry = new ToolRegistry();
  registry.register({ name: "test.visible", description: "test.visible", inputSchema: { type: "object", properties: {}, additionalProperties: false }, policy: { capability: "test.visible", tier: "common", interactionRequirement: "not_required", sideEffect: "none" }, async execute() { return { ok: true as const, output: null, effectStatus: "not_applicable" as const }; } });
  registry.register({ name: "test.hidden", description: "test.hidden", inputSchema: { type: "object", properties: {}, additionalProperties: false }, policy: { capability: "test.hidden", tier: "common", interactionRequirement: "not_required", sideEffect: "none" }, async execute() { hiddenExecutions += 1; return { ok: true as const, output: null, effectStatus: "not_applicable" as const }; } });
  try {
    const result = await new HeadlessRunEngine(model, registry, store, { now: () => at, createId: deterministicIds() }).run({ context: ownerContext("test.visible", "test.hidden"), model: "fake-model", prompt: "select one", visibleToolNames: ["test.visible"] });
    assert.equal(result.status, "succeeded");
    assert.equal(hiddenExecutions, 0);
    assert.equal(modelCalls, 2);
    assert.deepEqual((await store.getCheckpoint("run-1")), undefined);
  } finally { store.close(); }
});

test("catalog calls run the hidden target policy and persist the target Operation", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  let targetExecutions = 0;
  let modelCalls = 0;
  const model: ModelPort = { async generate(request) {
    modelCalls += 1;
    assert.deepEqual(request.tools?.map(tool => tool.name), ["tool_catalog"]);
    if (modelCalls === 1) {
      const call = { id: "catalog-call", name: "tool_catalog", input: { action: "call", tool_name: "test.hidden", arguments: { value: "works" } } };
      return response({ toolCalls: [call], finishReason: "tool_calls", assistantMessage: { role: "assistant", content: null, toolCalls: [call] } });
    }
    const toolMessage = request.messages.at(-1);
    assert.equal(toolMessage?.role, "tool");
    if (toolMessage?.role === "tool") assert.match(toolMessage.content, /permission_denied/);
    return response({ text: "denied", assistantMessage: { role: "assistant", content: "denied" } });
  } };
  const registry = new ToolRegistry();
  registry.register({ name: "tool_catalog", description: "Explore tools", inputSchema: { type: "object", properties: { action: { type: "string" }, tool_name: { type: "string" }, arguments: { type: "object" } }, required: ["action"], additionalProperties: true }, policy: { capability: "tool.catalog", tier: "common", interactionRequirement: "not_required", sideEffect: "none" }, async execute() { return { ok: true as const, output: null, effectStatus: "not_applicable" as const }; } });
  registry.register({ name: "test.hidden", description: "Hidden target", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false }, policy: { capability: "test.hidden", tier: "common", interactionRequirement: "not_required", sideEffect: "none" }, async execute() { targetExecutions += 1; return { ok: true as const, output: null, effectStatus: "not_applicable" as const }; } });
  try {
    const result = await new HeadlessRunEngine(model, registry, store, { now: () => at, createId: deterministicIds() }).run({ context: ownerContext("tool.catalog"), model: "fake-model", prompt: "call hidden", visibleToolNames: [] });
    assert.equal(result.status, "succeeded");
    assert.equal(targetExecutions, 0);
    const operation = await store.getOperation("operation-1");
    assert.equal(operation?.kind, "tool:test.hidden");
    assert.deepEqual(operation?.input, { value: "works" });
    assert.equal(operation?.state, "denied");
  } finally { store.close(); }
});

test("catalog call executes a hidden target when its own capability is granted", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  let targetExecutions = 0;
  let modelCalls = 0;
  const model: ModelPort = { async generate(request) {
    modelCalls += 1;
    if (modelCalls === 1) {
      assert.deepEqual(request.tools?.map(tool => tool.name), ["tool_catalog"]);
      const call = { id: "catalog-call", name: "tool_catalog", input: { action: "call", tool_name: "test.hidden", arguments: { value: "works" } } };
      return response({ toolCalls: [call], finishReason: "tool_calls", assistantMessage: { role: "assistant", content: null, toolCalls: [call] } });
    }
    const toolMessage = request.messages.at(-1);
    assert.equal(toolMessage?.role, "tool");
    if (toolMessage?.role === "tool") assert.match(toolMessage.content, /"ok":true,"output":\{"value":"works"\}/);
    return response({ text: "done", assistantMessage: { role: "assistant", content: "done" } });
  } };
  const registry = new ToolRegistry();
  registry.register({ name: "tool_catalog", description: "Explore tools", inputSchema: { type: "object", properties: { action: { type: "string" }, tool_name: { type: "string" }, arguments: { type: "object" } }, required: ["action"], additionalProperties: true }, policy: { capability: "tool.catalog", tier: "common", interactionRequirement: "not_required", sideEffect: "none" }, async execute() { return { ok: true as const, output: null, effectStatus: "not_applicable" as const }; } });
  registry.register({ name: "test.hidden", description: "Hidden target", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false }, policy: { capability: "test.hidden", tier: "common", interactionRequirement: "not_required", sideEffect: "none" }, async execute(input) { targetExecutions += 1; return { ok: true as const, output: input, effectStatus: "not_applicable" as const }; } });
  try {
    const result = await new HeadlessRunEngine(model, registry, store, { now: () => at, createId: deterministicIds() }).run({ context: ownerContext("tool.catalog", "test.hidden"), model: "fake-model", prompt: "call hidden", visibleToolNames: [] });
    assert.equal(result.status, "succeeded");
    assert.equal(targetExecutions, 1);
    const operation = await store.getOperation("operation-1");
    assert.equal(operation?.kind, "tool:test.hidden");
    assert.deepEqual(operation?.input, { value: "works" });
    assert.equal(operation?.state, "succeeded");
  } finally { store.close(); }
});

test("bounds every model request while keeping the full tool result durable", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  const requests: Parameters<ModelPort["generate"]>[0][] = [];
  const model: ModelPort = { async generate(request) {
    requests.push(request);
    assert.ok(estimateModelRequestTokens(request.messages, request.tools) <= 800);
    if (requests.length === 1) {
      const toolCall = { id: "large-call", name: "test.large", input: {} };
      return response({ toolCalls: [toolCall], finishReason: "tool_calls", assistantMessage: { role: "assistant", content: null, toolCalls: [toolCall] } });
    }
    const projected = request.messages.find(message => message.role === "tool" && message.toolCallId === "large-call");
    assert.equal(projected?.role, "tool");
    if (projected?.role === "tool") assert.ok(projected.content.includes("[tool output truncated]"));
    return response({ text: "done", assistantMessage: { role: "assistant", content: "done" } });
  } };
  const registry = new ToolRegistry();
  registry.register({
    name: "test.large", description: "Return a deliberately large diagnostic result", inputSchema: { type: "object", properties: {}, additionalProperties: false },
    policy: { capability: "test.large", tier: "common", interactionRequirement: "not_required", sideEffect: "none" },
    async execute() { return { ok: true, output: { text: `HEAD-${"x".repeat(100_000)}-TAIL` }, effectStatus: "not_applicable" }; },
  });
  try {
    const result = await new HeadlessRunEngine(model, registry, store, { now: () => at, createId: deterministicIds() })
      .run({ context: ownerContext("test.large"), model: "fake-model", prompt: "inspect", maxContextTokens: 800 });
    assert.equal(result.status, "succeeded");
    assert.equal(requests.length, 2);
    const durable = await store.getOperationResult("operation-1");
    assert.equal(JSON.stringify(durable?.output).includes("-TAIL"), true);
    assert.ok(JSON.stringify(durable?.output).length > 100_000);
  } finally { store.close(); }
});

test("classifies provider failures without exposing them in the Discord delivery", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  const providerError = Object.assign(new Error("provider rejected request"), { name: "OpenAIRequestError", category: "upstream", status: 413, retryable: false });
  const model: ModelPort = { async generate() { throw providerError; } };
  try {
    const result = await new HeadlessRunEngine(model, new ToolRegistry(), store, { now: () => at, createId: deterministicIds() })
      .run({ context: ownerContext(), model: "fake-model", prompt: "fail" });
    assert.equal(result.status, "failed");
    if (result.status === "failed") assert.deepEqual(result.failure, { category: "model_provider", errorName: "OpenAIRequestError", status: 413, retryable: false });
    assert.equal((await store.listPendingDeliveries())[0]?.payload.text, "這次處理失敗，請稍後再試。");
  } finally { store.close(); }
});

test("sends media data to the provider but omits base64 from model-call audit", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  const model: ModelPort = { async generate(request) {
    const user = request.messages.find(message => message.role === "user");
    assert.equal(typeof user?.content === "string" ? undefined : user?.content.find(part => part.type === "image")?.url, "data:image/png;base64,AQID");
    assert.equal(typeof user?.content === "string" ? undefined : user?.content.find(part => part.type === "file")?.data, "data:application/pdf;base64,BAUG");
    return response({ text: "seen", assistantMessage: { role: "assistant", content: "seen" } });
  } };
  try {
    const result = await new HeadlessRunEngine(model, new ToolRegistry(), store, { now: () => at, createId: deterministicIds() }).run({
      context: ownerContext(), model: "vision-model", prompt: "inspect",
      userContent: [{ type: "text", text: "inspect" }, { type: "image", url: "data:image/png;base64,AQID", detail: "auto" }, { type: "file", filename: "document.pdf", data: "data:application/pdf;base64,BAUG" }],
      maxContextTokens: 1_000,
    });
    assert.equal(result.status, "succeeded");
    const recorded = (await store.listModelCalls("run-1"))[0]?.messages.find(message => message.role === "user");
    assert.equal(typeof recorded?.content === "string" ? undefined : recorded?.content.find(part => part.type === "image")?.url, "[image data omitted from audit]");
    assert.equal(typeof recorded?.content === "string" ? undefined : recorded?.content.find(part => part.type === "file")?.data, "[file data omitted from audit]");
    assert.doesNotMatch(JSON.stringify(recorded), /AQID|BAUG/);
  } finally { store.close(); }
});

test("reminds the model on the final default turn so it can finish", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  let modelCalls = 0;
  let toolCalls = 0;
  let remindedAt: number | undefined;
  const model: ModelPort = {
    async generate(request) {
      modelCalls += 1;
      const reminder = request.messages.at(-1);
      if (reminder?.role === "system" && reminder.content.includes("final allowed model turn")) {
        remindedAt = modelCalls;
        return response({ text: "done", assistantMessage: { role: "assistant", content: "done" } });
      }
      const toolCall = { id: `call-${modelCalls}`, name: "test.continue", input: {} };
      return response({
        toolCalls: [toolCall],
        finishReason: "tool_calls",
        assistantMessage: { role: "assistant", content: null, toolCalls: [toolCall] },
      });
    },
  };
  const registry = new ToolRegistry();
  registry.register({
    name: "test.continue",
    description: "Continue until the Run reaches its model-turn ceiling",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    policy: { capability: "test.continue", tier: "common", interactionRequirement: "not_required", sideEffect: "none" },
    async execute() {
      toolCalls += 1;
      return { ok: true, output: null, effectStatus: "not_applicable" };
    },
  });
  try {
    const result = await new HeadlessRunEngine(model, registry, store, { now: () => at, createId: deterministicIds() })
      .run({ context: ownerContext("test.continue"), model: "fake-model", prompt: "keep going" });
    assert.equal(result.status, "succeeded");
    assert.equal(remindedAt, 50);
    assert.equal(modelCalls, remindedAt);
    assert.equal(toolCalls, remindedAt - 1);
  } finally { store.close(); }
});

test("still enforces a configured model-turn limit when the final reminder is ignored", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  const maxModelTurns = 3;
  const finalMessages: Array<Parameters<ModelPort["generate"]>[0]["messages"][number] | undefined> = [];
  const visibleToolCounts: number[] = [];
  const model: ModelPort = { async generate(request) {
    finalMessages.push(structuredClone(request.messages.at(-1)));
    visibleToolCounts.push(request.tools?.length ?? 0);
    const toolCall = { id: `call-${finalMessages.length}`, name: "test.continue", input: {} };
    return response({ toolCalls: [toolCall], finishReason: "tool_calls", assistantMessage: { role: "assistant", content: null, toolCalls: [toolCall] } });
  } };
  const registry = new ToolRegistry();
  registry.register({
    name: "test.continue", description: "Continue", inputSchema: { type: "object", properties: {}, additionalProperties: false },
    policy: { capability: "test.continue", tier: "common", interactionRequirement: "not_required", sideEffect: "none" },
    async execute() { return { ok: true, output: null, effectStatus: "not_applicable" }; },
  });
  try {
    const result = await new HeadlessRunEngine(model, registry, store, { now: () => at, createId: deterministicIds() })
      .run({ context: ownerContext("test.continue"), model: "fake-model", prompt: "keep going", maxModelTurns });
    assert.equal(result.status, "failed");
    if (result.status === "failed") assert.match(result.error, /model turn limit exceeded: 3/);
    assert.equal(finalMessages.length, maxModelTurns);
    const finalReminder = finalMessages.at(-1);
    assert.equal(finalReminder?.role, "system");
    assert.match(finalReminder?.content ?? "", /final allowed model turn \(3 of 3\)/);
    assert.deepEqual(visibleToolCounts, [1, 1, 0]);
    assert.equal((await store.listOperations("run-1")).length, 2);
  } finally { store.close(); }
});

test("passes the selected session reasoning effort to every model turn", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  const efforts: unknown[] = [];
  const model: ModelPort = { async generate(request) { efforts.push(request.reasoningEffort); return response({ text: "done", assistantMessage: { role: "assistant", content: "done" } }); } };
  try {
    const result = await new HeadlessRunEngine(model, new ToolRegistry(), store, { now: () => at, createId: deterministicIds() })
      .run({ context: ownerContext(), model: "selected", reasoningEffort: "high", prompt: "hello" });
    assert.equal(result.status, "succeeded");
    assert.deepEqual(efforts, ["high"]);
  } finally { store.close(); }
});

test("persists an intermediate delivery without completing the active Run", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  let started!: () => void; let release!: () => void;
  const modelStarted = new Promise<void>(resolve => { started = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const model: ModelPort = { async generate() { started(); await held; return response({ text: "final", assistantMessage: { role: "assistant", content: "final" } }); } };
  try {
    const engine = new HeadlessRunEngine(model, new ToolRegistry(), store, { now: () => at, createId: deterministicIds() });
    const running = engine.run({ context: ownerContext(), model: "fake", prompt: "work", maxContextTokens: 1_000, deliveryDestination: { kind: "discord", channelId: "123" } });
    await modelStarted;
    const checkpoint = await store.getCheckpoint("run-1");
    assert.equal((checkpoint?.data as Record<string, unknown>).maxContextTokens, 1_000);
    await store.createDeliveryIntent({ id: "delivery-middle", runId: "run-1", destination: { kind: "discord", channelId: "123" }, payload: { text: "still working" }, state: "pending", createdAt: at });
    assert.equal((await store.getRun("run-1"))?.state, "running");
    assert.equal((await store.getDeliveryIntent("delivery-middle"))?.payload.text, "still working");
    release();
    assert.equal((await running).status, "succeeded");
    assert.deepEqual((await store.listPendingDeliveries()).map(delivery => delivery.id), ["delivery-1", "delivery-middle"]);
  } finally { release(); store.close(); }
});

test("runs consecutive parallel-safe tools concurrently while preserving deterministic result order", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const events: string[] = [];
  let modelCalls = 0;
  const model: ModelPort = { async generate(request) {
    modelCalls += 1;
    if (modelCalls === 1) {
      const toolCalls = [
        { id: "call-a", name: "test.parallel_a", input: {} },
        { id: "call-b", name: "test.parallel_b", input: {} },
        { id: "call-c", name: "test.exclusive", input: {} },
      ];
      return response({ toolCalls, finishReason: "tool_calls", assistantMessage: { role: "assistant", content: null, toolCalls } });
    }
    assert.deepEqual(request.messages.filter(message => message.role === "tool").map(message => message.toolCallId), ["call-a", "call-b", "call-c"]);
    return response({ text: "done", assistantMessage: { role: "assistant", content: "done" } });
  } };
  const registry = new ToolRegistry();
  for (const name of ["test.parallel_a", "test.parallel_b"]) registry.register({
    name, description: name, inputSchema: { type: "object", properties: {}, additionalProperties: false },
    policy: { capability: name, tier: "common", interactionRequirement: "not_required", sideEffect: "none", concurrency: "parallel_safe" },
    async execute() { events.push(`${name}:start`); await held; events.push(`${name}:end`); return { ok: true, output: { name }, effectStatus: "not_applicable" }; },
  });
  registry.register({ name: "test.exclusive", description: "exclusive", inputSchema: { type: "object", properties: {}, additionalProperties: false }, policy: { capability: "test.exclusive", tier: "common", interactionRequirement: "not_required", sideEffect: "none" }, async execute() { events.push("exclusive:start"); return { ok: true, output: {}, effectStatus: "not_applicable" }; } });
  try {
    const engine = new HeadlessRunEngine(model, registry, store, { now: () => at, createId: deterministicIds(), maxParallelToolCalls: 2 });
    const running = engine.run({ context: ownerContext("test.parallel_a", "test.parallel_b", "test.exclusive"), model: "fake", prompt: "parallel" });
    while (events.filter(event => event.endsWith(":start")).length < 2) await new Promise(resolve => setImmediate(resolve));
    assert.equal(events.includes("exclusive:start"), false);
    release();
    assert.equal((await running).status, "succeeded");
    assert.ok(events.indexOf("exclusive:start") > events.indexOf("test.parallel_b:end"));
    assert.deepEqual((await store.listSteps("run-1")).map(step => [step.sequence, step.kind]), [[0, "model_call"], [1, "operation"], [2, "operation"], [3, "operation"], [4, "model_call"]]);
  } finally { release(); store.close(); }
});

test("durably steers another participant into the active Run at a safe boundary", async () => {
  const directory = mkdtempSync(join(tmpdir(), "umiro-steer-authority-"));
  const databasePath = join(directory, "execution.db");
  const store = new SQLiteExecutionStore(databasePath);
  const initialEvent = { id: "event-initial", occurredAt: at, identity: { transport: "discord", externalId: "alice", principalId: null }, conversation: { transport: "discord", externalId: "channel", kind: "channel" as const }, content: [{ type: "text" as const, text: "initial" }] };
  const ingested = await store.ingestInputEvent({ event: initialEvent, actorPrincipalId: "alice-principal", newConversationId: "conversation", newTurnId: "turn-initial", newRunId: "run-steer", createdAt: at });
  let modelStarted!: () => void;
  let releaseModel!: () => void;
  const started = new Promise<void>(resolve => { modelStarted = resolve; });
  const release = new Promise<void>(resolve => { releaseModel = resolve; });
  const requests: Parameters<ModelPort["generate"]>[0][] = [];
  let privilegedExecutions = 0;
  const model: ModelPort = { async generate(request) {
    requests.push(request);
    if (requests.length === 1) { modelStarted(); await release; return response({ text: "stale draft", assistantMessage: { role: "assistant", content: "stale draft" } }); }
    if (requests.length === 2) {
      const toolCall = { id: "call-owner", name: "test.owner", input: {} };
      return response({ toolCalls: [toolCall], finishReason: "tool_calls", assistantMessage: { role: "assistant", content: null, toolCalls: [toolCall] } });
    }
    return response({ text: "combined answer", assistantMessage: { role: "assistant", content: "combined answer" } });
  } };
  const registry = new ToolRegistry();
  registry.register({
    name: "test.owner",
    description: "Owner-only test tool",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    policy: { capability: "test.owner", tier: "privileged", interactionRequirement: "not_required", sideEffect: "none" },
    async execute() { privilegedExecutions += 1; return { ok: true, output: {}, effectStatus: "not_applicable" }; },
  });
  try {
    const engine = new HeadlessRunEngine(model, registry, store, { now: () => at, createId: deterministicIds() });
    const running = engine.run({ runId: "run-steer", context: ownerContext("test.owner", "shared"), conversationId: ingested.conversation.id, turnId: ingested.turn.id, model: "fake", prompt: "initial", steerControl: { flush: async () => {}, seal: async () => {} } });
    await started;
    const steeredEvent = { id: "event-steered", occurredAt: at, identity: { transport: "discord", externalId: "bob", principalId: null }, conversation: { transport: "discord", externalId: "channel", kind: "channel" as const }, content: [{ type: "text" as const, text: "bob adds context" }] };
    const steered = await store.steerInputEvent({ event: steeredEvent, actorPrincipalId: "bob-principal", actorRoles: ["member"], authority: { capabilities: capabilities("shared"), visibility: { kind: "restricted", principalIds: ["bob-principal"], labels: [], resources: [] }, instructionAuthority: "scoped" }, runId: "run-steer", newTurnId: "turn-steered", modelContent: [{ type: "text", text: "[Discord user Bob added:]\nbob adds context" }], createdAt: at });
    assert.equal(steered.turn.actorPrincipalId, "bob-principal");
    const carolEvent = { ...steeredEvent, id: "event-carol", identity: { ...steeredEvent.identity, externalId: "carol" }, content: [{ type: "text" as const, text: "carol adds context" }] };
    await store.steerInputEvent({ event: carolEvent, actorPrincipalId: "carol-principal", actorRoles: ["member"], authority: { capabilities: capabilities("shared"), visibility: { kind: "restricted", principalIds: ["carol-principal"], labels: [], resources: [] }, instructionAuthority: "none" }, runId: "run-steer", newTurnId: "turn-carol", modelContent: [{ type: "text", text: "[Discord user Carol added:]\ncarol adds context" }], createdAt: at });
    releaseModel();
    const result = await running;
    assert.equal(result.status, "succeeded");
    if (result.status === "succeeded") assert.equal(result.text, "combined answer");
    assert.equal(requests.length, 3);
    assert.equal(requests[1]?.messages.some(message => message.role === "assistant" && message.content === "stale draft"), false);
    assert.equal(requests[1]?.messages.some(message => message.role === "user" && JSON.stringify(message.content).includes("bob adds context")), true);
    assert.equal((await store.listPendingSteeredInputs("run-steer")).length, 0);
    assert.equal((await store.getRun("run-steer"))?.state, "succeeded");
    assert.equal((await store.listPendingDeliveries()).length, 1);
    assert.equal((await store.listTurns("conversation")).length, 3);
    assert.equal(privilegedExecutions, 0);
    assert.deepEqual((await store.getRun("run-steer"))?.context.authority, {
      capabilities: ["shared"],
      visibility: { kind: "restricted", principalIds: [], labels: [], resources: [] },
      instructionAuthority: "none",
    });
    assert.deepEqual((await store.getRun("run-steer"))?.context.actor.roles, []);
    store.close();
    const reopened = new SQLiteExecutionStore(databasePath);
    assert.deepEqual((await reopened.getRun("run-steer"))?.context.authority.capabilities, ["shared"]);
    reopened.close();
  } finally {
    try { store.close(); } catch {}
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a progress steer asks for an immediate answer without more tools", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  const event = { id: "event-initial", occurredAt: at, identity: { transport: "discord", externalId: "alice", principalId: null }, conversation: { transport: "discord", externalId: "channel", kind: "channel" as const }, content: [{ type: "text" as const, text: "research" }] };
  const ingested = await store.ingestInputEvent({ event, actorPrincipalId: "alice", newConversationId: "conversation", newTurnId: "turn-initial", newRunId: "run-progress", createdAt: at });
  let modelStarted!: () => void;
  let releaseModel!: () => void;
  const started = new Promise<void>(resolve => { modelStarted = resolve; });
  const release = new Promise<void>(resolve => { releaseModel = resolve; });
  let calls = 0;
  const model: ModelPort = { async generate(request) {
    calls += 1;
    if (calls === 1) { modelStarted(); await release; return response({ text: "stale", assistantMessage: { role: "assistant", content: "stale" } }); }
    assert.equal(request.tools?.length ?? 0, 0);
    assert.ok(request.messages.some(message => message.role === "system" && message.content.includes("immediate progress update")));
    return response({ text: "Current findings", assistantMessage: { role: "assistant", content: "Current findings" } });
  } };
  try {
    const running = new HeadlessRunEngine(model, new ToolRegistry(), store, { now: () => at, createId: deterministicIds() }).run({ runId: "run-progress", context: ownerContext(), conversationId: ingested.conversation.id, turnId: ingested.turn.id, model: "fake", prompt: "research", steerControl: { flush: async () => {}, seal: async () => {} } });
    await started;
    await store.steerInputEvent({ event: { ...event, id: "event-progress", content: [{ type: "text", text: "？" }] }, actorPrincipalId: "alice", actorRoles: ["owner"], authority: ownerContext().authority, runId: "run-progress", newTurnId: "turn-progress", modelContent: [{ type: "text", text: "[steer] <@alice>: ？" }], createdAt: at });
    releaseModel();
    const result = await running;
    assert.equal(result.status, "succeeded");
    assert.equal((await store.getRun("run-progress"))?.state, "succeeded");
    assert.equal(calls, 2);
  } finally { store.close(); }
});

test("a new progress question answers without starting another search", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  const registry = new ToolRegistry();
  registry.register({
    name: "test.search", description: "Search", inputSchema: { type: "object", properties: {}, additionalProperties: false },
    policy: { capability: "test.search", tier: "common", interactionRequirement: "not_required", sideEffect: "none" },
    async execute() { throw new Error("progress question must not start a search"); },
  });
  const model: ModelPort = { async generate(request) {
    assert.deepEqual(request.tools, []);
    assert.ok(request.messages.some(message => message.role === "system" && message.content.includes("immediate progress update")));
    return response({ text: "Here is the current status", assistantMessage: { role: "assistant", content: "Here is the current status" } });
  } };
  try {
    const result = await new HeadlessRunEngine(model, registry, store, { now: () => at, createId: deterministicIds() })
      .run({ context: ownerContext("test.search"), model: "fake", prompt: "？" });
    assert.equal(result.status, "succeeded");
  } finally { store.close(); }
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
        const failures = await store.listPendingDeliveries();
        assert.equal(failures.length, 1);
        assert.equal(failures[0]?.payload.text, "這次處理失敗，請稍後再試。");
        assert.doesNotMatch(String(failures[0]?.payload.text), /run-1|token budget exceeded/);
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

test("uses one remaining tool call from a parallel response and then answers", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  let executed = 0;
  let modelCalls = 0;
  const calls = Array.from({ length: 5 }, (_, index) => ({ id: `call-${index}`, name: "test.count", input: {} }));
  const model: ModelPort = { async generate(request) {
    modelCalls += 1;
    if (modelCalls === 1) return response({ toolCalls: calls, finishReason: "tool_calls", assistantMessage: { role: "assistant", content: null, toolCalls: calls } });
    assert.equal(request.tools?.length ?? 0, 0);
    assert.equal(request.messages.filter(message => message.role === "tool").length, 5);
    return response({ text: "One result verified; four were not checked.", assistantMessage: { role: "assistant", content: "One result verified; four were not checked." } });
  } };
  const registry = new ToolRegistry();
  registry.register({ name: "test.count", description: "Count", inputSchema: { type: "object", properties: {}, additionalProperties: false }, policy: { capability: "test.count", tier: "common", interactionRequirement: "not_required", sideEffect: "none", concurrency: "parallel_safe" }, async execute() { executed += 1; return { ok: true, output: { verified: true }, effectStatus: "not_applicable" }; } });
  try {
    const result = await new HeadlessRunEngine(model, registry, store, { now: () => at, createId: deterministicIds() }).run({ context: ownerContext("test.count"), model: "fake-model", prompt: "five", maxToolCalls: 1 });
    assert.equal(result.status, "succeeded");
    assert.equal(executed, 1);
    assert.equal((await store.listOperations("run-1")).length, 1);
  } finally { store.close(); }
});

test("allows a tool with enough time remaining before the configured deadline", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  let clockMs = Date.now();
  let executed = 0;
  let modelCalls = 0;
  const call = { id: "late-search", name: "test.search", input: {} };
  const model: ModelPort = { async generate(request) {
    modelCalls += 1;
    if (modelCalls === 1) {
      clockMs += 29_950; // Just over 30 seconds remain after this model response.
      return response({ toolCalls: [call], finishReason: "tool_calls", assistantMessage: { role: "assistant", content: null, toolCalls: [call] } });
    }
    return response({ text: "已有三家官方頁資料，其他資訊尚未查證。", assistantMessage: { role: "assistant", content: "已有三家官方頁資料，其他資訊尚未查證。" } });
  } };
  const registry = new ToolRegistry();
  registry.register({ name: "test.search", description: "Search", inputSchema: { type: "object", properties: {}, additionalProperties: false }, policy: { capability: "test.search", tier: "common", interactionRequirement: "not_required", sideEffect: "none", timeoutMs: 30_000 }, async execute() { executed += 1; return { ok: true, output: {}, effectStatus: "not_applicable" }; } });
  try {
    const result = await new HeadlessRunEngine(model, registry, store, { now: () => at, nowMs: () => clockMs, createId: deterministicIds() }).run({ context: ownerContext("test.search"), model: "fake-model", prompt: "continue", maxDurationMs: 60_000 });
    assert.equal(result.status, "succeeded", JSON.stringify(result));
    if (result.status === "succeeded") assert.match(result.text, /官方頁資料/);
    assert.equal(executed, 1);
    assert.equal(modelCalls, 2);
    assert.equal((await store.listOperations("run-1")).length, 1);
  } finally { store.close(); }
});

test("allows a 120-second search before the configured Run deadline", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  let clockMs = Date.now();
  let executed = 0;
  let modelCalls = 0;
  const call = { id: "search-call", name: "web_search", input: { query: "product" } };
  const model: ModelPort = { async generate(request) {
    modelCalls += 1;
    if (modelCalls === 1) {
      clockMs += 35_000; // 145 seconds remain; search timeout plus reply reserve requires 150.
      return response({ toolCalls: [call], finishReason: "tool_calls", assistantMessage: { role: "assistant", content: null, toolCalls: [call] } });
    }
    return response({ text: "Here is the verified information so far.", assistantMessage: { role: "assistant", content: "Here is the verified information so far." } });
  } };
  const registry = new ToolRegistry();
  registry.register({ name: "web_search", description: "Search", inputSchema: { type: "object", properties: { query: { type: "string" } } }, policy: { capability: "web.search", tier: "common", interactionRequirement: "not_required", sideEffect: "none", timeoutMs: 120_000 }, async execute() { executed += 1; return { ok: true, output: {}, effectStatus: "not_applicable" }; } });
  try {
    const result = await new HeadlessRunEngine(model, registry, store, { now: () => at, nowMs: () => clockMs, createId: deterministicIds() }).run({ context: ownerContext("web.search"), model: "fake-model", prompt: "research", maxDurationMs: 180_000 });
    assert.equal(result.status, "succeeded");
    assert.equal(executed, 1);
    assert.equal(modelCalls, 2);
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

test("ends at the duration ceiling when the model ignores abort", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  const model: ModelPort = { async generate() { return await new Promise<ModelResponse>(() => {}); } };
  try {
    const result = await new HeadlessRunEngine(model, new ToolRegistry(), store, { now: () => at, createId: deterministicIds() }).run({ context: ownerContext(), model: "fake-model", prompt: "wait", maxDurationMs: 20 });
    assert.equal(result.status, "failed");
    assert.equal((await store.getRun("run-1"))?.state, "failed");
    assert.equal((await store.listPendingDeliveries()).length, 1);
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
