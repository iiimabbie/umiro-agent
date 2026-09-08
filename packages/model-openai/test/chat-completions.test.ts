import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import type { ModelRequest } from "@umiro/core/model";
import {
  OpenAIChatCompletionsModel,
  OpenAIRequestError,
  buildOpenAIChatBody,
  normalizeChatContent,
  normalizeChatFinishReason,
  normalizeChatToolCalls,
  type OpenAIChatConfig,
} from "../src/index.js";

const config: OpenAIChatConfig = {
  baseUrl: "https://example.invalid/v1",
  apiKey: "test-only",
  auth: "bearer",
  tokenLimitField: "max_completion_tokens",
};
const request = (overrides: Partial<ModelRequest> = {}): ModelRequest => ({
  model: "test-model",
  messages: [{ role: "user", content: "Hello" }],
  ...overrides,
});

test("chat mapping preserves images, tools and tool-result correlation", () => {
  const input = request({
    messages: [
      { role: "system", content: "System" },
      { role: "user", content: [{ type: "text", text: "Inspect" }, { type: "image", url: "https://example.invalid/image.png", detail: "low" }] },
      { role: "assistant", content: null, toolCalls: [{ id: "call_1", name: "lookup", input: { query: "sample" } }] },
      { role: "tool", toolCallId: "call_1", content: "result" },
    ],
    tools: [{ name: "lookup", description: "Lookup", parameters: { type: "object" } }],
  });
  const body = buildOpenAIChatBody(input, config);
  assert.deepEqual(body.messages, [
    { role: "system", content: "System" },
    { role: "user", content: [{ type: "text", text: "Inspect" }, { type: "image_url", image_url: { url: "https://example.invalid/image.png", detail: "low" } }] },
    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{\"query\":\"sample\"}" } }] },
    { role: "tool", tool_call_id: "call_1", content: "result" },
  ]);
  assert.deepEqual(body.tools, [{ type: "function", function: input.tools?.[0] }]);
  assert.equal(body.max_completion_tokens, 8192);
  assert.equal("apiKey" in body, false);
});

test("chat mapping rejects files and respects token/reasoning settings", () => {
  assert.throws(() => buildOpenAIChatBody(request({ messages: [{ role: "user", content: [{ type: "file", filename: "a.pdf", data: "data:application/pdf;base64,AA==" }] }] }), config), /does not support direct file input/);
  const input = request({ maxOutputTokens: 128, reasoningEffort: "high" });
  const before = structuredClone(input);
  const body = buildOpenAIChatBody(input, { tokenLimitField: "max_tokens" });
  assert.equal(body.max_tokens, 128);
  assert.equal(body.reasoning_effort, "high");
  assert.equal("max_completion_tokens" in body, false);
  assert.deepEqual(input, before);
});

test("chat normalizers preserve malformed tool arguments as non-executable errors", () => {
  assert.equal(normalizeChatContent([{ text: "a" }, null, { other: "ignored" }, { text: "b" }]), "ab");
  assert.equal(normalizeChatFinishReason("future"), "unknown");
  for (const args of ["{", "[]", "null", "42"]) {
    const calls = normalizeChatToolCalls([{ id: "call_1", function: { name: "lookup", arguments: args } }]);
    assert.equal(calls.length, 1);
    assert.ok(calls[0]?.argumentError);
  }
  assert.deepEqual(normalizeChatToolCalls([{ id: "call_2", function: { name: "lookup", arguments: "{\"q\":\"value\"}" } }]), [{ id: "call_2", name: "lookup", input: { q: "value" } }]);
});

test("chat HTTP preserves endpoint, auth, response, usage and request ID", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), "https://example.invalid/v1/chat/completions");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-only");
    assert.equal(String(init?.body).includes("test-only"), false);
    return Response.json({
      id: "req_1",
      choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "call_http", function: { name: "lookup", arguments: "{\"q\":\"sample\"}" } }] } }],
      usage: { prompt_tokens: 100, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 7 } },
    });
  });
  const result = await new OpenAIChatCompletionsModel(config).generate(request());
  assert.equal(result.providerRequestId, "req_1");
  assert.equal(result.finishReason, "tool_calls");
  assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 20, reasoningTokens: 7 });
  assert.deepEqual(result.toolCalls, [{ id: "call_http", name: "lookup", input: { q: "sample" } }]);
});

test("chat supports unauthenticated endpoints and rejects missing bearer secrets", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => {
    calls++;
    assert.equal(new Headers(init?.headers).has("authorization"), false);
    return Response.json({ choices: [{ message: { content: "Local" }, finish_reason: "stop" }] });
  });
  const local = await new OpenAIChatCompletionsModel({ baseUrl: config.baseUrl, auth: "none" }).generate(request());
  assert.equal(local.text, "Local");
  await assert.rejects(new OpenAIChatCompletionsModel({ baseUrl: config.baseUrl }).generate(request()), (error: unknown) => error instanceof OpenAIRequestError && error.category === "authentication");
  assert.equal(calls, 1);
});

test("chat cancellation propagates without retrying", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => {
    calls++;
    return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }));
  });
  const controller = new AbortController();
  const pending = new OpenAIChatCompletionsModel(config).generate(request({ signal: controller.signal }));
  controller.abort(new Error("cancelled by test"));
  await assert.rejects(pending, /cancelled by test/);
  assert.equal(calls, 1);
});

test("chat retries temporary HTTP failures but not permanent failures", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    if (calls < 3) return new Response("Busy", { status: 429, headers: { "retry-after": "0" } });
    return Response.json({ choices: [{ message: { content: "Recovered" }, finish_reason: "stop" }] });
  });
  const recovered = await new OpenAIChatCompletionsModel(config).generate(request());
  assert.equal(recovered.text, "Recovered");
  assert.equal(calls, 3);

  calls = 0;
  t.mock.restoreAll();
  t.mock.method(globalThis, "fetch", async () => { calls++; return new Response("Unauthorized", { status: 401 }); });
  await assert.rejects(new OpenAIChatCompletionsModel(config).generate(request()), (error: unknown) => error instanceof OpenAIRequestError && error.category === "authentication" && error.status === 401);
  assert.equal(calls, 1);
});

test("chat completes through a local OpenAI-compatible HTTP server", async (t) => {
  let receivedAuthorization = "";
  const server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", chunk => chunks.push(Buffer.from(chunk)));
    incoming.on("end", () => {
      receivedAuthorization = incoming.headers.authorization ?? "";
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      assert.equal(body.model, "test-model");
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ choices: [{ message: { content: "Integration response" }, finish_reason: "stop" }] }));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const result = await new OpenAIChatCompletionsModel({ ...config, baseUrl: `http://127.0.0.1:${address.port}/v1` }).generate(request());
  assert.equal(receivedAuthorization, "Bearer test-only");
  assert.equal(result.text, "Integration response");
});
