import assert from "node:assert/strict";
import test from "node:test";
import { buildInitialMessages, conversationHistoryToMessages, estimateModelMessageTokens, partitionContextTokenBudget } from "../src/index.js";

test("conversation history projection preserves identity, ordering, attachments, and replies", () => {
  const messages = conversationHistoryToMessages([
    { turn: { id: "t1", conversationId: "c", sequence: 1, actorPrincipalId: "p1", actorIdentity: { transport: "discord", externalId: "42" }, inputEventId: "discord:m1", primaryRunId: "r1", content: [{ type: "text", text: "先前訊息" }, { type: "artifact_reference", artifactId: "a1" }], createdAt: "2026-09-20T00:00:00.000Z" }, actorDisplayName: "小明", assistantText: "先前回答" },
    { turn: { id: "t2", conversationId: "c", sequence: 2, actorPrincipalId: "p2", inputEventId: "discord:m2", content: [{ type: "text", text: "下一則" }], createdAt: "2026-09-20T00:01:00.000Z" } },
  ]);
  assert.deepEqual(messages.map(message => message.role), ["user", "assistant", "user"]);
  assert.match(messages[0]!.content as string, /discord:m1[\s\S]*<@42>\(小明\)[\s\S]*先前訊息[\s\S]*\[attachment:a1\]/);
  assert.equal(messages[1]!.content, "先前回答");
  assert.match(messages[2]!.content as string, /discord:m2[\s\S]*下一則/);
});

test("history reservation is capped at half of the shared budget", () => {
  const result = partitionContextTokenBudget(100, [{ role: "user", content: "x".repeat(1_000) }]);
  assert.equal(result.contextMaxTokens + result.reservedHistoryTokens, 100);
  assert.equal(result.reservedHistoryTokens, 50);
  const withCurrent = partitionContextTokenBudget(100, [{ role: "user", content: "x" }], { role: "user", content: "current" });
  assert.ok(withCurrent.contextMaxTokens < 100 - withCurrent.reservedHistoryTokens);
});

test("binary media payload size does not consume the text context budget", () => {
  const current = { role: "user" as const, content: [
    { type: "text" as const, text: "請查看附件" },
    { type: "image" as const, url: `data:image/png;base64,${"A".repeat(5_000_000)}` },
    { type: "file" as const, filename: "document.pdf", data: "B".repeat(5_000_000) },
  ] };
  const history = [{ role: "user" as const, content: "最新歷史" }, { role: "assistant" as const, content: "最新回答" }];
  const budget = partitionContextTokenBudget(24_000, history, current);
  assert.ok(budget.contextMaxTokens > 0);
  const messages = buildInitialMessages({ prompt: "請查看附件", userContent: current.content, history, maxContextTokens: 24_000 });
  assert.deepEqual(messages.slice(-3).map(message => message.role), ["user", "assistant", "user"]);
  const shortImage = estimateModelMessageTokens({ role: "user", content: [{ type: "image", url: "data:image/png;base64,short" }] });
  const longImage = estimateModelMessageTokens({ role: "user", content: [{ type: "image", url: `data:image/png;base64,${"A".repeat(5_000_000)}` }] });
  assert.equal(longImage, shortImage);
});
