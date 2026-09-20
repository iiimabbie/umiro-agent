import assert from "node:assert/strict";
import test from "node:test";
import { compileModelProfiles, resolveModelProfile } from "../src/model-profiles.js";

test("model profiles inherit defaults while preserving explicit overrides", () => {
  const compiled = compileModelProfiles({ model: "gemma4:31b", protocol: "openai_responses", modelCapabilities: ["vision", "function_tools"], profiles: {
    named: { model: "named-model", reasoningEffort: "high" },
    optOut: { model: "text-model", capabilities: [] },
    override: { model: "chat-model", protocol: "openai_chat_completions", capabilities: ["vision"] },
  } });
  assert.deepEqual(compiled.profiles.named!.capabilities, ["vision", "function_tools"]);
  assert.equal(compiled.profiles.named!.protocol, "openai_responses");
  assert.deepEqual(compiled.profiles.optOut!.capabilities, []);
  assert.equal(compiled.profiles.override!.protocol, "openai_chat_completions");
  assert.deepEqual(compiled.profiles.override!.capabilities, ["vision"]);
});

test("raw model selections use the current default profile as a template", () => {
  const compiled = compileModelProfiles({ model: "gemma4:31b", protocol: "openai_responses", modelCapabilities: ["vision"], profiles: { raw: { model: "named-model", capabilities: [] } } });
  assert.deepEqual(resolveModelProfile("gpt-5.6-sol", compiled.defaultProfile, compiled.profiles), {
    id: "gpt-5.6-sol", model: "gpt-5.6-sol", protocol: "openai_responses", capabilities: ["vision"],
  });
  assert.deepEqual(resolveModelProfile("raw", compiled.defaultProfile, compiled.profiles).capabilities, []);
});
