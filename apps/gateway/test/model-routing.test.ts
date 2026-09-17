import assert from "node:assert/strict";
import test from "node:test";
import type { ModelPort, ModelRequest } from "@umiro/core";
import { modelProtocolMap, OpenAIProtocolRouter, parseOpenAIProtocol, resolveDelegatedModel } from "../src/model-routing.js";

const request = (model: string): ModelRequest => ({ model, messages: [{ role: "user", content: "hi" }] });
const adapter = (name: string, calls: string[]): ModelPort => ({ async generate(input) { calls.push(`${name}:${input.model}`); return { text: name, toolCalls: [], finishReason: "stop", usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 }, assistantMessage: { role: "assistant", content: name } }; } });

test("model profiles route to their configured OpenAI protocol", async () => {
  const calls: string[] = [];
  const routes = modelProtocolMap([{ model: "reasoner", protocol: "openai_responses" }, { model: "local", protocol: "openai_chat_completions" }]);
  const router = new OpenAIProtocolRouter(adapter("responses", calls), adapter("chat", calls), routes, "openai_responses");
  assert.equal((await router.generate(request("local"))).text, "chat");
  assert.equal((await router.generate(request("reasoner"))).text, "responses");
  assert.equal((await router.generate(request("unlisted"))).text, "responses");
  router.configure(modelProtocolMap([{ model: "reasoner", protocol: "openai_chat_completions" }]), "openai_chat_completions");
  assert.equal((await router.generate(request("reasoner"))).text, "chat");
  assert.equal((await router.generate(request("unlisted-after-reload"))).text, "chat");
  assert.deepEqual(calls, ["chat:local", "responses:reasoner", "responses:unlisted", "chat:reasoner", "chat:unlisted-after-reload"]);
});

test("protocol routing rejects invalid values and ambiguous model assignments", () => {
  assert.equal(parseOpenAIProtocol(undefined), "openai_responses");
  assert.throws(() => parseOpenAIProtocol("ollama"), /protocol/);
  assert.throws(() => modelProtocolMap([{ model: "same", protocol: "openai_responses" }, { model: "same", protocol: "openai_chat_completions" }]), /conflicting protocols/);
});

test("delegated model profiles resolve default and named profiles to concrete model IDs", () => {
  const profiles = { fast: { model: "test-model-fast" } };
  assert.equal(resolveDelegatedModel("default", "gemma4:latest", profiles), "gemma4:latest");
  assert.equal(resolveDelegatedModel("fast", "test-model-default", profiles), "test-model-fast");
  assert.equal(resolveDelegatedModel("explicit-model", "gemma4:latest", profiles), "explicit-model");
});
