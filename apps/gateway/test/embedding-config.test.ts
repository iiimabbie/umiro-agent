import assert from "node:assert/strict";
import test from "node:test";
import { createConfiguredEmbedder } from "../src/embedding-config.js";
import { GeminiEmbedder, OpenAICompatibleEmbedder } from "../src/embedding-worker.js";

test("embedding is opt-in and an explicit disabled provider remains off", () => {
  assert.equal(createConfiguredEmbedder(undefined, {}), undefined);
  assert.equal(createConfiguredEmbedder({ provider: "disabled" }, {}), undefined);
});

test("configured providers use user-selected models and credential variables", () => {
  const gemini = createConfiguredEmbedder({ provider: "gemini", model: "custom-gemini", apiKeyEnv: "MY_EMBED_KEY" }, { MY_EMBED_KEY: "secret" });
  assert.ok(gemini instanceof GeminiEmbedder);
  assert.equal(gemini.model, "gemini:custom-gemini");

  const compatible = createConfiguredEmbedder({ provider: "openai-compatible", model: "local-model", baseUrl: "http://localhost:11434/v1" }, {});
  assert.ok(compatible instanceof OpenAICompatibleEmbedder);
  assert.match(compatible.model, /^openai-compatible:[a-f0-9]{12}:local-model$/);
});

test("an explicitly configured credential must exist", () => {
  assert.throws(
    () => createConfiguredEmbedder({ provider: "openai-compatible", model: "private-model", baseUrl: "https://embed.example/v1", apiKeyEnv: "PRIVATE_KEY" }, {}),
    /PRIVATE_KEY/,
  );
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
