import assert from "node:assert/strict";
import test from "node:test";
import { ActionRow, ButtonStyle, ComponentType } from "discord.js";
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

test("a durable button result edits the original message and disables completed actions", async () => {
  const adapter = new DiscordJsAdapter();
  adapter.onButton(async interaction => {
    assert.equal(interaction.messageContent, "original");
    return { messageContent: "original\n\n☑️ **Approve SOUL.md**\nupdated", disableButtonIds: ["approve"] };
  });
  let edited: Record<string, unknown> | undefined;
  const ActionRowForTest = ActionRow as unknown as new (data: Record<string, unknown>) => unknown;
  const row = new ActionRowForTest({ type: ComponentType.ActionRow, components: [{ type: ComponentType.Button, custom_id: "umiro:button:set:approve", label: "Approve SOUL.md", style: ButtonStyle.Success }] });
  const interaction = {
    customId: "umiro:button:set:approve", channelId: "channel", guildId: "guild", user: { id: "owner" }, message: { content: "original", components: [row] },
    async deferUpdate() {}, async editReply(value: Record<string, unknown>) { edited = value; }, async followUp() { throw new Error("successful actions must not create a second message"); },
  };
  await (adapter as unknown as { handleButton(value: unknown): Promise<void> }).handleButton(interaction);
  assert.equal(edited?.content, "original\n\n☑️ **Approve SOUL.md**\nupdated");
  const components = edited?.components as Array<{ toJSON(): { components: Array<{ disabled?: boolean }> } }>;
  assert.equal(components[0]!.toJSON().components[0]!.disabled, true);
});
