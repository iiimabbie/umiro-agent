import assert from "node:assert/strict";
import test from "node:test";
import { createCurrentTimeContextProvider, createDiscordApplicationEmojiContextProvider, discordOutputPolicyProvider, discordRuntimeContextProvider, PUBLIC_WEB_SOURCE_INSTRUCTION, runtimeModelContextProvider } from "../src/discord-context.js";

test("Discord thread context exposes its parent Forum as trusted transport metadata", async () => {
  const blocks = await discordRuntimeContextProvider.load({
    runId: "run",
    execution: { actor: { id: "owner", kind: "human", roles: ["owner"] }, authority: { capabilities: [], visibility: { kind: "all" }, instructionAuthority: "full" }, origin: { kind: "interactive", transport: "discord", conversationId: "conversation" } },
    prompt: "post here",
    inputEvent: { id: "discord:message", occurredAt: "now", identity: { transport: "discord", externalId: "owner", principalId: null }, conversation: { transport: "discord", externalId: "thread", kind: "thread" }, content: [{ type: "text", text: "post here" }], metadata: { channelId: "thread", channelName: "Do not use stale channel name", guildId: "guild", threadId: "thread", threadName: "Latest post title", threadParentId: "forum", threadParentName: "Travel", threadParentKind: "forum" } },
  });
  assert.equal(blocks.length, 1);
  assert.deepEqual(JSON.parse(blocks[0]!.content), { transport: "discord", currentChannel: { id: "thread", kind: "thread", name: "Latest post title" }, guild: { id: "guild" }, currentPost: { id: "thread", name: "Latest post title" }, currentForum: { id: "forum", name: "Travel" }, thread: { id: "thread", name: "Latest post title", parent: { id: "forum", kind: "forum", name: "Travel" } } });
  assert.equal(blocks[0]!.instructionAuthority, "none");
  assert.equal(blocks[0]!.retention, "essential");
});

test("Discord non-thread currentChannel includes the live channel name", async () => {
  const blocks = await discordRuntimeContextProvider.load({
    runId: "run-channel",
    execution: { actor: { id: "owner", kind: "human", roles: ["owner"] }, authority: { capabilities: [], visibility: { kind: "all" }, instructionAuthority: "full" }, origin: { kind: "interactive", transport: "discord", conversationId: "conversation" } },
    prompt: "hello",
    inputEvent: { id: "discord:message-channel", occurredAt: "now", identity: { transport: "discord", externalId: "owner", principalId: null }, conversation: { transport: "discord", externalId: "channel", kind: "channel" }, content: [{ type: "text", text: "hello" }], metadata: { channelId: "channel", channelName: "fresh-channel-name" } },
  });
  assert.deepEqual(JSON.parse(blocks[0]!.content), { transport: "discord", currentChannel: { id: "channel", kind: "channel", name: "fresh-channel-name" } });
});

test("current time context is available to every Run with an explicit timezone", async () => {
  const provider = createCurrentTimeContextProvider(() => new Date("2026-09-12T01:02:03.000Z"), "Europe/London");
  const blocks = await provider.load({ runId: "scheduled", execution: {} as never, prompt: "today?" });
  assert.match(blocks[0]?.content ?? "", /2026-09-12T01:02:03\.000Z \(Europe\/London:/);
  assert.equal(blocks[0]?.retention, "essential");
});

test("runtime model context tells an interactive agent its fixed model profile", async () => {
  const blocks = await runtimeModelContextProvider.load({ runId: "run", execution: { actor: { id: "owner", kind: "human", roles: ["owner"] }, authority: { capabilities: [], visibility: { kind: "all" }, instructionAuthority: "full" }, origin: { kind: "interactive", transport: "discord", conversationId: "conversation" }, modelProfile: { id: "default", model: "gpt-5.6-sol", protocol: "openai_responses", capabilities: [], reasoningEffort: "medium" } }, prompt: "which model?" });
  assert.deepEqual(JSON.parse(blocks[0]!.content), { activeModel: { id: "gpt-5.6-sol", profile: "default", protocol: "openai_responses", reasoningEffort: "medium" } });
  assert.equal(blocks[0]!.instructionAuthority, "none");
  assert.equal(blocks[0]!.retention, "essential");
});

test("Discord Application Emoji names are injected only for Discord Runs", async () => {
  const provider = createDiscordApplicationEmojiContextProvider(() => [{ name: "party" }, { name: "dance" }, { name: "bad-name" }]);
  const request = { runId: "run", execution: {} as never, prompt: "hi", inputEvent: { id: "discord:message", occurredAt: "now", identity: { transport: "discord", externalId: "owner", principalId: null }, conversation: { transport: "discord", externalId: "channel", kind: "channel" as const }, content: [{ type: "text" as const, text: "hi" }] } };
  const blocks = await provider.load(request);
  assert.match(blocks[0]?.content ?? "", /:dance: :party:/);
  assert.doesNotMatch(blocks[0]?.content ?? "", /bad-name/);
  assert.equal(blocks[0]?.instructionAuthority, "none");
  assert.deepEqual(await provider.load({ ...request, inputEvent: { ...request.inputEvent, identity: { ...request.inputEvent.identity, transport: "test" } } }), []);
});

test("an accepted Discord Run requires final text without a silence sentinel", async () => {
  const request = { runId: "run", execution: {} as never, prompt: "hi", inputEvent: { id: "discord:message", occurredAt: "now", identity: { transport: "discord", externalId: "owner", principalId: null }, conversation: { transport: "discord", externalId: "channel", kind: "channel" as const }, content: [{ type: "text" as const, text: "hi" }] } };
  const blocks = await discordOutputPolicyProvider.load(request);
  assert.equal(blocks.length, 1);
  assert.match(blocks[0]?.content ?? "", /non-empty final text response/);
  assert.match(blocks[0]?.content ?? "", /\[Official status page\]\(https:\/\/status\.example\/\) \| \[Incident page\]\(https:\/\/status\.example\/incidents\/123\)/);
  assert.match(PUBLIC_WEB_SOURCE_INSTRUCTION, /one final line/);
  assert.equal(blocks[0]?.instructionAuthority, "scoped");
  assert.deepEqual(await discordOutputPolicyProvider.load({ ...request, inputEvent: { ...request.inputEvent, identity: { ...request.inputEvent.identity, transport: "test" } } }), []);
});
