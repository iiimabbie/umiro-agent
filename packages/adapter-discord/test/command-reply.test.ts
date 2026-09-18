import assert from "node:assert/strict";
import test from "node:test";
import { commandReplyContent } from "../src/client.js";

test("new command reports the user intent while retaining archive evidence", () => {
  assert.equal(commandReplyContent("new", { archived: true, conversationId: "conversation" }), "已開新對話；舊對話已封存。");
  assert.equal(commandReplyContent("new", { archived: false, reason: "no_active_conversation" }), "目前沒有進行中的對話；下一則訊息會開始新對話。");
  assert.equal(commandReplyContent("archive", { archived: true }), "指令已完成。");
});
test("built-in operational commands render their returned content", () => {
  assert.equal(commandReplyContent("status", { content: "狀態" }), "狀態");
  assert.equal(commandReplyContent("restart", { content: "已排程重啟 Gateway。" }), "已排程重啟 Gateway。");
});
