import assert from "node:assert/strict";
import { OpenAIChatCompletionsModel, OpenAIModelCatalog, OpenAIResponsesModel } from "../src/index.js";

const baseUrl = process.env.LLM_BASE_URL?.trim();
const apiKey = process.env.LLM_API_KEY?.trim();
assert.ok(baseUrl, "LLM_BASE_URL is required");
assert.ok(apiKey, "LLM_API_KEY is required");

const config = { baseUrl, apiKey, timeoutMs: 120_000 };
const requestedModel = process.env.LLM_MODEL?.trim();
const catalog = new OpenAIModelCatalog(config);
const models = await catalog.listConversationModels();
const model = requestedModel || (models.includes("gpt-5.6-terra") ? "gpt-5.6-terra" : models[0]);
assert.ok(model, "The gateway returned no conversation model");

const protocol = process.env.LLM_PROTOCOL?.trim() ?? "openai_responses";
const adapter = protocol === "openai_chat_completions"
  ? new OpenAIChatCompletionsModel(config)
  : new OpenAIResponsesModel(config);
const marker = "UMIRO_OPENAI_SMOKE_OK";
const response = await adapter.generate({
  model,
  messages: [{ role: "user", content: `Reply with exactly ${marker} and nothing else.` }],
  maxOutputTokens: 64,
});
assert.equal(response.text.trim(), marker);
console.log(JSON.stringify({ ok: true, protocol, model, usage: response.usage, providerRequestId: response.providerRequestId ?? null }));
