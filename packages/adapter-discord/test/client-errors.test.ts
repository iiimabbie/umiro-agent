import assert from "node:assert/strict";
import test from "node:test";
import { DiscordJsAdapter, type DiscordAdapterErrorContext } from "../src/client.js";

function message(id: string) {
  return {
    id,
    channelId: "channel",
    guildId: "guild",
    author: { id: "author", bot: false, globalName: null, username: "author" },
    reference: null,
    channel: { isThread: () => false },
    mentions: { users: new Map<string, unknown>() },
    content: id,
    createdAt: new Date("2026-09-09T00:00:00.000Z"),
    attachments: new Map(),
  };
}

test("message handler failures are reported and do not poison the channel queue", async () => {
  const adapter = new DiscordJsAdapter();
  const errors: DiscordAdapterErrorContext[] = [];
  let calls = 0;
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  adapter.onError((_error, context) => errors.push(context));
  adapter.onMessage(async envelope => {
    calls++;
    if (envelope.messageId === "first") throw new Error("expected failure");
    finish();
  });
  const enqueue = (adapter as unknown as { enqueueMessage(value: unknown): void }).enqueueMessage.bind(adapter);
  enqueue(message("first"));
  enqueue(message("second"));
  await finished;
  assert.equal(calls, 2);
  assert.deepEqual(errors, [{ event: "message", channelId: "channel", messageId: "first" }]);
});
