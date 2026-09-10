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

test("steer is offered before the channel queue while an earlier message is running", async () => {
  const adapter = new DiscordJsAdapter();
  let release!: () => void;
  let started!: () => void;
  const firstStarted = new Promise<void>(resolve => { started = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const handled: string[] = [];
  const steered: string[] = [];
  adapter.onMessage(async envelope => { handled.push(envelope.messageId); started(); await blocked; });
  adapter.onSteer(async envelope => { if (envelope.messageId !== "second") return false; steered.push(envelope.messageId); return true; });
  const enqueue = (adapter as unknown as { enqueueMessage(value: unknown): void }).enqueueMessage.bind(adapter);
  enqueue(message("first"));
  await firstStarted;
  enqueue(message("second"));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(steered, ["second"]);
  assert.deepEqual(handled, ["first"]);
  release();
});

test("steer rejected after the active Run is sealed falls back to the channel queue", async () => {
  const adapter = new DiscordJsAdapter();
  let releaseFirst!: () => void;
  let markFirstStarted!: () => void;
  let markSecondHandled!: () => void;
  const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve; });
  const firstBlocked = new Promise<void>(resolve => { releaseFirst = resolve; });
  const secondHandled = new Promise<void>(resolve => { markSecondHandled = resolve; });
  const handled: string[] = [];
  let sealed = false;
  adapter.onMessage(async envelope => {
    handled.push(envelope.messageId);
    if (envelope.messageId === "first") {
      markFirstStarted();
      await firstBlocked;
    } else {
      markSecondHandled();
    }
  });
  adapter.onSteer(async envelope => envelope.messageId === "second" && !sealed);
  const enqueue = (adapter as unknown as { enqueueMessage(value: unknown): void }).enqueueMessage.bind(adapter);
  enqueue(message("first"));
  await firstStarted;
  sealed = true;
  enqueue(message("second"));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(handled, ["first"]);
  releaseFirst();
  await secondHandled;
  assert.deepEqual(handled, ["first", "second"]);
});
