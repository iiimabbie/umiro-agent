import assert from "node:assert/strict";
import test from "node:test";
import { configurationRequirements, modelEndpoint } from "../src/setup-mode.js";

test("an empty installation enters setup mode with every required field", () => {
  assert.deepEqual(configurationRequirements({ model: "not-configured" }), [
    "LLM_BASE_URL",
    "LLM_MODEL",
    "DISCORD_TOKEN",
    "UMIRO_OWNER_DISCORD_ID",
  ]);
});

test("a configured installation has no setup requirements", () => {
  assert.deepEqual(configurationRequirements({
    baseUrl: "https://api.example.com/v1",
    model: "example-model",
    discordToken: "token",
    ownerDiscordId: "owner",
  }), []);
});

test("the setup runtime uses a local inert model endpoint", () => {
  assert.equal(modelEndpoint(undefined), "http://127.0.0.1");
  assert.equal(modelEndpoint(" https://api.example.com/v1 "), "https://api.example.com/v1");
});
