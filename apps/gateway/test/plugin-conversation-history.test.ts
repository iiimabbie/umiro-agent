import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationStore } from "@umiro/core";
import { PluginConversationHistory } from "../src/plugin-conversation-history.js";

test("daily transcript keeps dialogue in the selected timezone and strips system bookkeeping", async () => {
  const store = {
    async listConversations() {
      return [{ conversation: { id: "conversation-1", revision: 0, state: "active", createdAt: "2026-09-17T00:00:00Z", updatedAt: "2026-09-18T02:00:00Z" }, location: { transport: "discord", externalId: "channel-1", kind: "channel" }, lastActivityAt: "2026-09-18T02:00:00Z", turnCount: 2 }];
    },
    async listConversationMessages() {
      return {
        conversation: { id: "conversation-1", revision: 0, state: "active", createdAt: "2026-09-17T00:00:00Z", updatedAt: "2026-09-18T02:00:00Z" },
        location: { transport: "discord", externalId: "channel-1", kind: "channel" },
        messages: [
          { turn: { id: "turn-old", conversationId: "conversation-1", sequence: 0, actorPrincipalId: "owner", inputEventId: "event-old", content: [{ type: "text", text: "yesterday" }], createdAt: "2026-09-17T15:59:59.000Z" }, actorDisplayName: "主人" },
          { turn: { id: "turn-1", conversationId: "conversation-1", sequence: 1, actorPrincipalId: "owner", inputEventId: "event-1", content: [{ type: "text", text: "[System] bookkeeping\n今天去散步" }], createdAt: "2026-09-17T16:00:01.000Z" }, actorDisplayName: "主人", reply: { runId: "run-1", state: "succeeded", at: "2026-09-17T16:00:02.000Z", text: "風很舒服。" } },
        ],
        hasMore: false,
      };
    },
  } as unknown as ConversationStore;
  const result = await new PluginConversationHistory(store).transcriptByDate({ date: "2026-09-18", timezone: "Asia/Taipei", maxCharacters: 10_000 });
  assert.equal(result.conversations, 1);
  assert.equal(result.messages, 2);
  assert.match(result.text, /主人:\n今天去散步/);
  assert.match(result.text, /Assistant:\n風很舒服。/);
  assert.doesNotMatch(result.text, /yesterday|System|discord|channel-1|16:00/);
  assert.equal(result.truncated, false);
});

test("daily transcript validates date, timezone, and bounds output", async () => {
  const store = { async listConversations() { return []; } } as unknown as ConversationStore;
  const history = new PluginConversationHistory(store);
  await assert.rejects(history.transcriptByDate({ date: "2026-02-30", timezone: "UTC" }), /real calendar date/);
  await assert.rejects(history.transcriptByDate({ date: "2026-09-18", timezone: "Nowhere\/Missing" }), /invalid IANA timezone/);
  assert.equal((await history.transcriptByDate({ date: "2026-09-18", timezone: "UTC" })).text, "No journal-worthy conversation found.");
});
