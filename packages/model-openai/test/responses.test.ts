import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelRequest } from "@umiro/core/model";
import {
  OpenAIRequestError,
  OpenAIResponsesModel,
  buildOpenAIResponsesBody,
  callResponsesWebSearch,
  callResponsesImageGeneration,
  normalizeResponsesFinishReason,
  normalizeResponsesToolCalls,
  responsesOutputText,
  type OpenAIConnectionConfig,
} from "../src/index.js";

const config: OpenAIConnectionConfig = { baseUrl: "https://example.invalid/v1", apiKey: "test-only" };
const request = (overrides: Partial<ModelRequest> = {}): ModelRequest => ({ model: "test-model", messages: [{ role: "user", content: "Hello" }], ...overrides });

test("responses mapping preserves instructions, images, files, tool calls and results", () => {
  const input = request({
    messages: [
      { role: "system", content: "System one" },
      { role: "system", content: "System two" },
      { role: "user", content: [{ type: "text", text: "Inspect" }, { type: "image", url: "data:image/png;base64,AA==", detail: "low" }, { type: "file", filename: "sample.pdf", data: "data:application/pdf;base64,AA==" }, { type: "file", filename: "notes.docx", data: "data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,AA==" }] },
      { role: "assistant", content: "Working", toolCalls: [{ id: "call_1", name: "lookup", input: { query: "sample" } }] },
      { role: "tool", toolCallId: "call_1", content: "result" },
    ],
    tools: [{ name: "lookup", description: "Lookup", parameters: { type: "object" } }],
    maxOutputTokens: 321,
    reasoningEffort: "high",
  });
  const body = buildOpenAIResponsesBody(input);
  assert.equal(body.instructions, "System one\n\nSystem two");
  assert.equal(body.max_output_tokens, 321);
  assert.deepEqual(body.reasoning, { effort: "high" });
  assert.deepEqual(body.input, [
    { role: "user", content: [{ type: "input_text", text: "Inspect" }, { type: "input_image", image_url: "data:image/png;base64,AA==", detail: "low" }, { type: "input_file", filename: "sample.pdf", file_data: "data:application/pdf;base64,AA==" }, { type: "input_file", filename: "notes.docx", file_data: "data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,AA==" }] },
    { role: "assistant", content: [{ type: "output_text", text: "Working" }] },
    { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{\"query\":\"sample\"}" },
    { type: "function_call_output", call_id: "call_1", output: "result" },
  ]);
});

test("responses image generation returns decoded image bytes", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { tools?: unknown };
    assert.deepEqual(body.tools, [{ type: "image_generation" }]);
    return Response.json({ id: "resp_image", status: "completed", output: [{ type: "image_generation_call", result: "AQID" }] });
  });
  const result = await callResponsesImageGeneration({ config, model: "image-model", prompt: "draw" });
  assert.deepEqual([...result.bytes], [1, 2, 3]); assert.equal(result.responseId, "resp_image");
});

test("responses normalizers parse text, calls, malformed arguments and finish reasons", () => {
  const raw = { status: "completed", output: [
    { type: "message", content: [{ type: "output_text", text: " First " }, { type: "refusal", text: "ignored" }] },
    { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{\"q\":\"value\"}" },
  ] };
  assert.equal(responsesOutputText(raw), "First");
  const calls = normalizeResponsesToolCalls(raw.output);
  assert.deepEqual(calls, [{ id: "call_1", name: "lookup", input: { q: "value" } }]);
  assert.equal(normalizeResponsesFinishReason(raw, calls), "tool_calls");
  assert.equal(normalizeResponsesFinishReason({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }, []), "length");
  assert.ok(normalizeResponsesToolCalls([{ type: "function_call", call_id: "bad", name: "lookup", arguments: "[]" }])[0]?.argumentError);
});

test("responses HTTP preserves endpoint, auth, output, usage and request ID", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), "https://example.invalid/v1/responses");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-only");
    return Response.json({
      id: "resp_1", status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "Calling" }] }, { type: "function_call", call_id: "call_http", name: "lookup", arguments: "{\"q\":\"sample\"}" }],
      usage: { input_tokens: 100, output_tokens: 20, output_tokens_details: { reasoning_tokens: 7 } },
    });
  });
  const result = await new OpenAIResponsesModel(config).generate(request());
  assert.equal(result.providerRequestId, "resp_1");
  assert.equal(result.text, "Calling");
  assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 20, reasoningTokens: 7 });
  assert.deepEqual(result.toolCalls, [{ id: "call_http", name: "lookup", input: { q: "sample" } }]);
});

test("responses streaming emits text deltas and returns the canonical completed response", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => {
    assert.equal((JSON.parse(String(init?.body)) as { stream?: boolean }).stream, true);
    const events = [
      { type: "response.output_text.delta", delta: "Hel" },
      { type: "response.output_text.delta", delta: "lo" },
      { type: "response.completed", response: { id: "resp_stream", status: "completed", output_text: "Hello", output: [], usage: { input_tokens: 2, output_tokens: 1 } } },
    ];
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  });
  const deltas: string[] = [];
  const result = await new OpenAIResponsesModel(config).generate(request({ onTextDelta: delta => { deltas.push(delta); } }));
  assert.deepEqual(deltas, ["Hel", "lo"]);
  assert.equal(result.text, "Hello");
  assert.equal(result.providerRequestId, "resp_stream");
});

test("responses supports unauthenticated endpoints and caller cancellation", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => {
    calls++;
    assert.equal(new Headers(init?.headers).has("authorization"), false);
    if (calls === 1) return Response.json({ status: "completed", output_text: "Local", output: [] });
    return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }));
  });
  const model = new OpenAIResponsesModel({ baseUrl: config.baseUrl, auth: "none" });
  assert.equal((await model.generate(request())).text, "Local");
  const controller = new AbortController();
  const pending = model.generate(request({ signal: controller.signal }));
  controller.abort(new Error("cancelled by test"));
  await assert.rejects(pending, /cancelled by test/);
  assert.equal(calls, 2);
});

test("hosted web search forwards cancellation to the HTTP request", async (t) => {
  let requestSignal: AbortSignal | undefined;
  t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => {
    requestSignal = init?.signal ?? undefined;
    return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }));
  });
  const controller = new AbortController();
  const pending = callResponsesWebSearch({ config: { ...config, timeoutMs: 120_000 }, model: "test-model", query: "example", signal: controller.signal });
  controller.abort(new Error("search cancelled"));
  await assert.rejects(pending, /search cancelled/);
  assert.equal(requestSignal?.aborted, true);
});

test("responses rejects API errors and empty output with structured categories", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => ++calls === 1
    ? Response.json({ error: { message: "unsupported route" } })
    : Response.json({ status: "completed", output: [] }));
  await assert.rejects(new OpenAIResponsesModel(config).generate(request()), (error: unknown) => error instanceof OpenAIRequestError && error.category === "upstream");
  await assert.rejects(new OpenAIResponsesModel(config).generate(request()), (error: unknown) => error instanceof OpenAIRequestError && error.category === "invalid_response");
});
