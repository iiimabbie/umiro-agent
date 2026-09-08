import assert from "node:assert/strict";
import { test } from "node:test";
import { OpenAIModelCatalog, isMediaModel, parseModelIds } from "../src/index.js";

test("model discovery parsing is deterministic and filters media models", () => {
  assert.deepEqual(parseModelIds({ data: [{ id: "z-model" }, { id: "a-model" }, { id: "a-model" }, {}, null] }), ["a-model", "z-model"]);
  assert.equal(isMediaModel("gpt-image-2"), true);
  assert.equal(isMediaModel("gpt-5.6-terra"), false);
});

test("model catalog authenticates, caches and filters conversation choices", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => {
    calls++;
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer secret");
    return Response.json({ data: [{ id: "gpt-image-2" }, { id: "gpt-5.6-terra" }] });
  });
  const catalog = new OpenAIModelCatalog({ baseUrl: "https://example.invalid/v1", apiKey: "secret" });
  assert.deepEqual(await catalog.listConversationModels(), ["gpt-5.6-terra"]);
  assert.deepEqual(await catalog.list(), ["gpt-5.6-terra", "gpt-image-2"]);
  assert.equal(calls, 1);
});
