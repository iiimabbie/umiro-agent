import assert from "node:assert/strict";
import test from "node:test";
import { createConfiguredEmbedder, EMBEDDING_BASE_URL_SECRET } from "../src/embedding-config.js";
import { GeminiEmbedder, OpenAICompatibleEmbedder, RateLimitedTextEmbedder } from "../src/embedding-worker.js";

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
