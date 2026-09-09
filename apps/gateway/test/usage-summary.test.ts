import assert from "node:assert/strict";
import test from "node:test";
import type { ModelCallRecord } from "@umiro/core";
import { summarizeModelUsage } from "../src/usage-summary.js";

const call = (id: string, model: string, inputTokens: number, outputTokens: number, reasoningTokens = 0): ModelCallRecord => ({ id, runId: "run", stepId: `step-${id}`, model, messages: [], response: { text: "", toolCalls: [], finishReason: "stop", usage: { inputTokens, outputTokens, reasoningTokens }, assistantMessage: { role: "assistant", content: "" } }, createdAt: "now" });

test("usage summary groups durable calls and only prices configured models", () => {
  const complete = summarizeModelUsage([call("1", "a", 100, 20, 5), call("2", "a", 50, 10)], { a: { inputUsdPerMillion: 2, outputUsdPerMillion: 8 } });
  assert.deepEqual(complete, { calls: 2, inputTokens: 150, outputTokens: 30, reasoningTokens: 5, estimatedCostMicrousd: 540, byModel: { a: { calls: 2, inputTokens: 150, outputTokens: 30, reasoningTokens: 5, estimatedCostMicrousd: 540 } } });
  const partial = summarizeModelUsage([call("1", "a", 1, 1), call("2", "b", 1, 1)], { a: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } });
  assert.equal(partial.estimatedCostMicrousd, undefined);
  assert.equal(partial.byModel.b?.estimatedCostMicrousd, undefined);
});
