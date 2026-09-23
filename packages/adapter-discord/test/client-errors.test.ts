import assert from "node:assert/strict";
import test from "node:test";
import { ActionRow, ButtonStyle, ComponentType } from "discord.js";
import { DiscordJsAdapter, type DiscordAdapterErrorContext } from "../src/client.js";

function message(id: string, channel: Record<string, unknown> = { isThread: () => false }) {
  return {
    id,
    channelId: "channel",
    guildId: "guild",
    author: { id: "author", bot: false, globalName: null, username: "author" },
    reference: null,
    channel,
    mentions: { users: new Map<string, unknown>() },
    content: id,
    createdAt: new Date("2026-09-09T00:00:00.000Z"),
    attachments: new Map(),
  };
}

test("ingress normalization reads current channel and thread parent names", async () => {
  const adapter = new DiscordJsAdapter();
  adapter.onMessage(async () => {});
  const normalize = (adapter as unknown as { normalize(value: unknown): Promise<{ channelName?: string; threadName?: string; threadParentName?: string } | undefined> }).normalize.bind(adapter);
  const channel = await normalize(message("channel", { isThread: () => false, name: "renamed-channel" }));
  assert.equal(channel?.channelName, "renamed-channel");
  const thread = await normalize(message("thread", { isThread: () => true, isThreadOnly: () => true, id: "thread", name: "renamed-post", parentId: "forum", parent: { name: "renamed-forum", isThreadOnly: () => true } }));
  assert.deepEqual({ channelName: thread?.channelName, threadName: thread?.threadName, threadParentName: thread?.threadParentName }, { channelName: "renamed-post", threadName: "renamed-post", threadParentName: "renamed-forum" });
});

test("thread starter retrieval uses Discord's parent-aware starter API", async () => {
  const adapter = new DiscordJsAdapter();
  const fetched: string[] = [];
  const thread = (kind: string) => ({
    isThread: () => true,
    messages: {},
    name: `${kind} post`,
    fetchStarterMessage: async () => {
      fetched.push(kind);
      return { id: `${kind}-starter`, channelId: "parent", author: { id: "author", displayName: "Author", bot: true }, content: "starter text", createdAt: new Date("2026-09-09T00:00:00Z"), attachments: new Map() };
    },
  });
  const channels = (adapter as unknown as { client: { channels: { fetch(id: string): Promise<unknown> } } }).client.channels;
  channels.fetch = async id => thread(id);
  for (const kind of ["parent", "forum"]) {
    const result = await adapter.fetchThreadStarter({ threadId: kind });
    assert.equal(result?.messageId, `${kind}-starter`);
    assert.equal(result?.content, "starter text");
    assert.equal(result?.authorBot, true);
  }
  assert.deepEqual(fetched, ["parent", "forum"]);
});

test("thread starter retrieval stops waiting when its abort signal fires", async () => {
  const adapter = new DiscordJsAdapter();
  const channels = (adapter as unknown as { client: { channels: { fetch(id: string): Promise<unknown> } } }).client.channels;
  let finish!: (value: never) => void;
  channels.fetch = async () => ({ isThread: () => true, messages: {}, name: "post", fetchStarterMessage: () => new Promise(resolve => { finish = resolve; }) });
  const controller = new AbortController();
  const pending = adapter.fetchThreadStarter({ threadId: "thread", signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new DOMException("Timed out", "TimeoutError"));
  await assert.rejects(pending, error => error instanceof DOMException && error.name === "TimeoutError");
  finish(undefined as never);
});

test("rename operations validate their channel kind, name length, and abort signal", async () => {
  const adapter = new DiscordJsAdapter();
  let channel: Record<string, unknown> = { isThread: () => true, isThreadOnly: () => false, setName: async (name: string) => { renamed.push(name); } };
  const renamed: string[] = [];
  const client = (adapter as unknown as { client: { channels: { fetch(id: string): Promise<unknown> } } }).client;
  client.channels.fetch = async () => channel;
  await adapter.renameThread({ threadId: "thread", name: "New post title" });
  assert.deepEqual(renamed, ["New post title"]);
  await assert.rejects(adapter.renameThread({ threadId: "thread", name: "" }), /1 to 100/);
  await assert.rejects(adapter.renameThread({ threadId: "thread", name: "x".repeat(101) }), /1 to 100/);
  const aborted = new AbortController(); aborted.abort(new Error("cancelled"));
  await assert.rejects(adapter.renameForum({ channelId: "forum", name: "New forum", signal: aborted.signal }), /cancelled/);
  channel = { isThread: () => false, isThreadOnly: () => true, setName: async (name: string) => { renamed.push(name); } };
  await adapter.renameForum({ channelId: "forum", name: "New forum" });
  assert.deepEqual(renamed, ["New post title", "New forum"]);
  channel = { isThread: () => false, isThreadOnly: () => false, setName: async () => { throw new Error("must not rename channel"); } };
  await assert.rejects(adapter.renameForum({ channelId: "ordinary-channel", name: "not a forum" }), /not a Forum/);
});

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

test("typing is refreshed until the active response finishes", async () => {
  const adapter = new DiscordJsAdapter();
  let refreshes = 0;
  adapter.sendTyping = async () => { refreshes++; };
  const stop = adapter.startTyping("channel", 5);
  await new Promise(resolve => setTimeout(resolve, 13));
  stop();
  const stoppedAt = refreshes;
  await new Promise(resolve => setTimeout(resolve, 8));
  assert.ok(stoppedAt >= 2);
  assert.equal(refreshes, stoppedAt);
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

test("restart waits until the initial reply is visible before handing off credentials", async () => {
  const adapter = new DiscordJsAdapter();
  const events: string[] = [];
  adapter.onCommand([{ name: "restart", description: "restart", ephemeral: true }], async () => ({ content: "Restarting... wait for me!" }));
  adapter.onRestart(async interaction => { events.push(`restart:${interaction.applicationId}:${interaction.token}`); });
  const interaction = {
    commandName: "restart", applicationId: "application", token: "token", channelId: "channel", guildId: "guild", user: { id: "owner" }, options: { data: [] },
    async deferReply() { events.push("defer"); },
    async editReply(value: { content: string }) { events.push(`reply:${value.content}`); },
  };
  await (adapter as unknown as { handleCommand(value: unknown): Promise<void> }).handleCommand(interaction);
  assert.deepEqual(events, ["defer", "reply:Restarting... wait for me!", "restart:application:token"]);
});
