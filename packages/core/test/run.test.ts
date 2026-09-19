import assert from "node:assert/strict";
import test from "node:test";
import {
  assertRunTransition,
  assertStepTransition,
  buildInitialMessages,
  canTransitionRun,
  isTerminalRunState,
} from "../src/index.js";
import { HEURISTIC_CONTEXT_TOKEN_ESTIMATOR } from "../src/context/index.js";

test("run lifecycle permits waiting and resumption without invented main states", () => {
  assert.equal(canTransitionRun("queued", "running"), true);
  assert.equal(canTransitionRun("running", "waiting"), true);
  assert.equal(canTransitionRun("waiting", "running"), true);
  assert.equal(canTransitionRun("running", "succeeded"), true);
  assert.equal(isTerminalRunState("succeeded"), true);
});

test("terminal runs and steps reject further transitions", () => {
  assert.throws(() => assertRunTransition("succeeded", "running"), /invalid run transition/);
  assert.throws(() => assertRunTransition("failed", "running"), /invalid run transition/);
  assert.throws(() => assertStepTransition("succeeded", "running"), /invalid step transition/);
});

test("initial messages keep system, newest complete history turn, and current user", () => {
  const omitted: Array<{ omittedHistoryMessages: number; retainedHistoryMessages: number; truncatedHistoryMessages: number }> = [];
  const messages = buildInitialMessages({
    prompt: "current",
    assembledContext: { blocks: [{ id: "soul", providerId: "test", role: "soul", content: "identity", source: { kind: "test", ref: "soul" }, influence: "instruction", instructionAuthority: "full" }], omittedBlockIds: [], characterCount: 8, estimatedTokenCount: 1 },
    history: [
      { role: "user", content: "old history ".repeat(100) },
      { role: "assistant", content: "old answer ".repeat(100) },
      { role: "user", content: "new history" },
      { role: "assistant", content: "new answer" },
    ],
    maxContextTokens: 180,
    onContextOmission: details => omitted.push(details),
  });
  assert.deepEqual(messages.map(message => message.role), ["system", "user", "assistant", "user"]);
  assert.equal(messages[1]?.content, "new history");
  assert.equal(messages[2]?.content, "new answer");
  assert.equal(messages[3]?.content, "current");
  assert.ok(omitted.length > 0);
  assert.ok(messages.every(message => message.role !== "tool"));
});

test("CJK history truncation is estimator-bounded and observable", () => {
  const omissions: Array<{ omittedHistoryMessages: number; retainedHistoryMessages: number; truncatedHistoryMessages: number }> = [];
  const messages = buildInitialMessages({
    prompt: "現在問題",
    history: [{ role: "user", content: "這是一段很長的中文歷史訊息。".repeat(200) }, { role: "assistant", content: "回答" }],
    maxContextTokens: 180,
    onContextOmission: details => omissions.push(details),
  });
  const historical = messages.find(message => message.role === "user" && typeof message.content === "string" && message.content.includes("history truncated"));
  assert.ok(historical);
  assert.ok(HEURISTIC_CONTEXT_TOKEN_ESTIMATOR.estimate(JSON.stringify(historical)) <= 180 - HEURISTIC_CONTEXT_TOKEN_ESTIMATOR.estimate(JSON.stringify(messages.at(-1))));
  assert.ok(omissions[0]?.truncatedHistoryMessages);
});
