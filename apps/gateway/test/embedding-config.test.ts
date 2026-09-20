import assert from "node:assert/strict";
import test from "node:test";
import { createConfiguredEmbedder, createConfiguredEmbedders, EMBEDDING_BASE_URL_SECRET, validateEmbeddingConfig } from "../src/embedding-config.js";
import { GeminiEmbedder, OpenAICompatibleEmbedder, RateLimitedTextEmbedder, type RateLimitScheduler } from "../src/embedding-worker.js";

test("embedding is opt-in and an explicit disabled provider remains off", () => {
  assert.equal(createConfiguredEmbedder(undefined, {}), undefined);
  assert.equal(createConfiguredEmbedder({ provider: "disabled" }, {}), undefined);
});

test("configured providers use user-selected models and the managed embedding secret", () => {
  const gemini = createConfiguredEmbedder({ provider: "gemini", model: "custom-gemini" }, { UMIRO_EMBEDDING_API_KEY: "secret" });
  assert.ok(gemini instanceof GeminiEmbedder);
  assert.equal(gemini.model, "gemini:custom-gemini");

  const compatible = createConfiguredEmbedder({ provider: "openai-compatible", model: "local-model" }, { [EMBEDDING_BASE_URL_SECRET]: "http://localhost:11434/v1" });
  assert.ok(compatible instanceof OpenAICompatibleEmbedder);
  assert.match(compatible.model, /^openai-compatible:[a-f0-9]{12}:local-model$/);
});

test("Gemini requires the managed embedding secret", () => {
  assert.throws(
    () => createConfiguredEmbedder({ provider: "gemini", model: "custom-gemini" }, {}),
    /Embedding API key is not configured/,
  );
});

test("recall tuning is bounded for provider-specific score distributions", () => {
  const environment = { [EMBEDDING_BASE_URL_SECRET]: "https://embed.example/v1" };
  assert.ok(createConfiguredEmbedder({ provider: "openai-compatible", model: "custom", recallLimit: 3, minSimilarity: 0.42 }, environment));
  assert.throws(() => createConfiguredEmbedder({ provider: "openai-compatible", model: "custom", recallLimit: 0 }, environment), /recallLimit/);
  assert.throws(() => createConfiguredEmbedder({ provider: "openai-compatible", model: "custom", minSimilarity: 1.1 }, environment), /minSimilarity/);
});

test("provider request limits are opt-in and bounded", () => {
  const environment = { [EMBEDDING_BASE_URL_SECRET]: "https://embed.example/v1" };
  assert.ok(createConfiguredEmbedder({ provider: "openai-compatible", model: "custom", requestsPerMinute: 3 }, environment) instanceof RateLimitedTextEmbedder);
  assert.throws(() => createConfiguredEmbedder({ provider: "openai-compatible", model: "custom", requestsPerMinute: 0 }, environment), /requestsPerMinute/);
  assert.throws(() => createConfiguredEmbedder({ provider: "openai-compatible", model: "custom", requestsPerMinute: 601 }, environment), /requestsPerMinute/);
});

test("OpenAI-compatible embedder calls the configured endpoint", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    requestUrl = String(input); requestInit = init;
    return new Response(JSON.stringify({ data: [{ embedding: [0.25, 0.75] }] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const embedder = new OpenAICompatibleEmbedder("mine", "https://embed.example/v1/", "token", fetcher);
  assert.deepEqual(await embedder.embed("hello"), [0.25, 0.75]);
  assert.equal(requestUrl, "https://embed.example/v1/embeddings");
  assert.equal((requestInit?.headers as Record<string, string>).authorization, "Bearer token");
  assert.deepEqual(JSON.parse(String(requestInit?.body)), { model: "mine", input: "hello" });
});

test("OpenAI-compatible embedder batches inputs and restores response index order", async () => {
  let requestBody: unknown;
  const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const embedder = new OpenAICompatibleEmbedder("mine", "https://embed.example/v1", undefined, fetcher);
  assert.deepEqual(await embedder.embedMany(["first", "second"]), [[1, 0], [0, 1]]);
  assert.deepEqual(requestBody, { model: "mine", input: ["first", "second"] });
});

test("split embedding configuration requires a shared safe dimension and query model", () => {
  validateEmbeddingConfig({ provider: "openai-compatible", model: "voyage-4" });
  assert.throws(() => validateEmbeddingConfig({ provider: "openai-compatible", model: "voyage-4", separateQueryModel: true, dimensions: 1024 }), /queryModel/);
  assert.throws(() => validateEmbeddingConfig({ provider: "openai-compatible", model: "voyage-4", separateQueryModel: true, queryModel: "voyage-4-lite", dimensions: 1.5 }), /dimensions/);
  assert.throws(() => validateEmbeddingConfig({ provider: "openai-compatible", model: "voyage-4", queryModel: "voyage-4-lite", dimensions: 1024 }), /separateQueryModel/);
  validateEmbeddingConfig({ provider: "openai-compatible", model: "voyage-4", separateQueryModel: true, queryModel: "voyage-4-lite", dimensions: 1024 }, { [EMBEDDING_BASE_URL_SECRET]: "https://embed.example/v1" });
});

test("split OpenAI-compatible and Voyage requests route role and shared dimensions", async () => {
  const requests: unknown[] = [];
  const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => { requests.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }), { status: 200 }); }) as typeof fetch;
  const document = new OpenAICompatibleEmbedder("voyage-4", "https://embed.example/v1", undefined, fetcher, 2, "document", true);
  const query = document.forRole!("query");
  await document.embed("doc"); await query.embed("query");
  assert.deepEqual(requests, [
    { model: "voyage-4", input: "doc", output_dimension: 2, input_type: "document" },
    { model: "voyage-4", input: "query", output_dimension: 2, input_type: "query" },
  ]);
  const normal = new OpenAICompatibleEmbedder("model", "https://embed.example/v1", undefined, fetcher);
  await normal.embed("plain");
  assert.deepEqual(requests.at(-1), { model: "model", input: "plain" });
});

test("split Gemini requests use retrieval task types and output dimensionality", async () => {
  let requestBody: unknown;
  const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => { requestBody = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ embedding: { values: [1, 0] } }), { status: 200 }); }) as typeof fetch;
  const document = new GeminiEmbedder("gemini-embedding-001", "secret", fetcher, 2, "document", true);
  await document.embed("doc");
  assert.deepEqual(requestBody, { model: "models/gemini-embedding-001", content: { parts: [{ text: "doc" }] }, taskType: "RETRIEVAL_DOCUMENT", outputDimensionality: 2 });
  await document.forRole!("query").embed("query");
  assert.equal((requestBody as Record<string, unknown>).taskType, "RETRIEVAL_QUERY");
});

test("configured split embedders share one index identity and one rate limiter", () => {
  const result = createConfiguredEmbedders({ provider: "openai-compatible", model: "voyage-4", separateQueryModel: true, queryModel: "voyage-4-lite", dimensions: 1024, requestsPerMinute: 3 }, { [EMBEDDING_BASE_URL_SECRET]: "https://embed.example/v1" });
  assert.ok(result);
  assert.equal(result.document.indexModel, result.query.indexModel);
  assert.equal(result.document.dimensions, 1024);
  assert.equal(result.query.dimensions, 1024);
});

test("configured split Voyage embedders send document and query model IDs through the shared RPM view", async () => {
  const calls: Array<{ model: string; inputType: string }> = [];
  const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { model: string; input_type: string };
    calls.push({ model: body.model, inputType: body.input_type });
    return new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }), { status: 200 });
  }) as typeof fetch;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetcher;
  try {
    const result = createConfiguredEmbedders({ provider: "openai-compatible", model: "voyage-4", separateQueryModel: true, queryModel: "voyage-4-lite", dimensions: 2, requestsPerMinute: 600 }, { [EMBEDDING_BASE_URL_SECRET]: "https://embed.example/v1" });
    assert.ok(result);
    await result.document.embed("doc");
    await result.query.embed("query");
    assert.deepEqual(calls, [{ model: "voyage-4", inputType: "document" }, { model: "voyage-4-lite", inputType: "query" }]);
  } finally { globalThis.fetch = originalFetch; }
});

test("split Voyage delegates keep their own models while sharing RPM and foreground priority", async () => {
  let now = 0; let timerId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock: RateLimitScheduler & { advance(ms: number): void } = {
    now: () => now,
    setTimeout(callback, delayMs) { const id = ++timerId; timers.set(id, { at: now + delayMs, callback }); return id; },
    clearTimeout(handle) { timers.delete(Number(handle)); },
    advance(ms) { now += ms; for (const [id, timer] of [...timers].sort((left, right) => left[1].at - right[1].at)) if (timer.at <= now) { timers.delete(id); timer.callback(); } },
  };
  const calls: Array<{ model: string; inputType: string }> = [];
  let resolveFirst: (() => void) | undefined;
  const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { model: string; input_type: string };
    calls.push({ model: body.model, inputType: body.input_type });
    if (calls.length === 1) await new Promise<void>(resolve => { resolveFirst = resolve; });
    return new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }), { status: 200 });
  }) as typeof fetch;
  const document = new OpenAICompatibleEmbedder("voyage-4", "https://embed.example/v1", undefined, fetcher, 2, "document", true);
  const query = new OpenAICompatibleEmbedder("voyage-4-lite", "https://embed.example/v1", undefined, fetcher, 2, "query", true, document.indexModel);
  const pair = RateLimitedTextEmbedder.pair(document, query, 60, clock);
  const first = pair.document.embed("doc-1");
  const background = pair.document.forBackground!();
  const second = background.embed("doc-2");
  const foreground = pair.query.embed("query");
  await Promise.resolve();
  assert.deepEqual(calls, [{ model: "voyage-4", inputType: "document" }]);
  resolveFirst!();
  await first;
  clock.advance(1000);
  await Promise.resolve();
  assert.deepEqual(calls, [{ model: "voyage-4", inputType: "document" }, { model: "voyage-4-lite", inputType: "query" }]);
  await foreground;
  clock.advance(1000);
  await second;
  assert.deepEqual(calls.map(call => call.model), ["voyage-4", "voyage-4-lite", "voyage-4"]);
});
