import assert from "node:assert/strict";
import test from "node:test";
import type { ModelPort, ModelResponse } from "@umiro/core/model";
import { SQLiteExecutionStore } from "@umiro/storage-sqlite";
import { parseCliArgs, runCli } from "../src/cli.js";

const response: ModelResponse = {
  text: "pong",
  toolCalls: [],
  finishReason: "stop",
  usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 },
  assistantMessage: { role: "assistant", content: "pong" },
};

test("parses model, protocol, and a multi-word prompt", () => {
  assert.deepEqual(
    parseCliArgs(["--model", "gemma4:31b", "--protocol=openai_responses", "hello", "world"]),
    { model: "gemma4:31b", protocol: "openai_responses", prompt: "hello world" },
  );
});

test("accepts pnpm's forwarded option separator", () => {
  assert.deepEqual(
    parseCliArgs(["--", "--model", "gemma4:31b", "ping"]),
    { model: "gemma4:31b", prompt: "ping" },
  );
});

test("sends stdin to the selected model and keeps response text on stdout", async () => {
  let requestModel = "";
  let requestText = "";
  let stdout = "";
  let stderr = "";
  const fakeModel: ModelPort = {
    async generate(request) {
      requestModel = request.model;
      const message = request.messages[0];
      requestText = message?.role === "user" && typeof message.content === "string" ? message.content : "";
      return response;
    },
  };

  await runCli(["--model=gemma4:31b"], {
    env: { LLM_BASE_URL: "https://example.invalid/v1", LLM_API_KEY: "secret" },
    stdinIsTTY: false,
    readStdin: async () => "ping\n",
    writeStdout: value => { stdout += value; },
    writeStderr: value => { stderr += value; },
    listModels: async () => { throw new Error("explicit model must skip discovery"); },
    createModel: () => fakeModel,
    createStore: () => new SQLiteExecutionStore(":memory:"),
  });

  assert.equal(requestModel, "gemma4:31b");
  assert.equal(requestText, "ping");
  assert.equal(stdout, "pong\n");
  assert.match(stderr, /model: gemma4:31b/);
  assert.doesNotMatch(stderr, /secret/);
});

test("discovers a default model when none is configured", async () => {
  let selectedModel = "";
  await runCli(["ping"], {
    env: { LLM_BASE_URL: "https://example.invalid/v1" },
    stdinIsTTY: true,
    readStdin: async () => "",
    writeStdout: () => undefined,
    writeStderr: () => undefined,
    listModels: async () => ["gemma4:31b"],
    createModel: () => ({
      async generate(request) {
        selectedModel = request.model;
        return response;
      },
    }),
    createStore: () => new SQLiteExecutionStore(":memory:"),
  });
  assert.equal(selectedModel, "gemma4:31b");
});
