import assert from "node:assert/strict";
import test from "node:test";
import { createCurrentTimeContextProvider, createDiscordApplicationEmojiContextProvider, discordOutputPolicyProvider, discordRuntimeContextProvider } from "../src/discord-context.js";

test("Discord thread context exposes its parent Forum as trusted transport metadata", async () => {
  const blocks = await discordRuntimeContextProvider.load({
    runId: "run",
    execution: { actor: { id: "owner", kind: "human", roles: ["owner"] }, authority: { capabilities: [], visibility: { kind: "all" }, instructionAuthority: "full" }, origin: { kind: "interactive", transport: "discord", conversationId: "conversation" } },
    prompt: "post here",
    inputEvent: { id: "discord:message", occurredAt: "now", identity: { transport: "discord", externalId: "owner", principalId: null }, conversation: { transport: "discord", externalId: "thread", kind: "thread" }, content: [{ type: "text", text: "post here" }], metadata: { channelId: "thread", guildId: "guild", threadId: "thread", threadParentId: "forum", threadParentName: "Travel", threadParentKind: "forum" } },
  });
  assert.equal(blocks.length, 1);
  assert.deepEqual(JSON.parse(blocks[0]!.content), { transport: "discord", currentChannel: { id: "thread", kind: "thread" }, guild: { id: "guild" }, currentPost: { id: "thread" }, currentForum: { id: "forum", name: "Travel" }, thread: { id: "thread", parent: { id: "forum", kind: "forum", name: "Travel" } } });
  assert.equal(blocks[0]!.instructionAuthority, "none");
  assert.equal(blocks[0]!.retention, "essential");
});

test("Discord output policy defines an explicit no-text response", async () => {
  const blocks = await discordOutputPolicyProvider.load({
    runId: "run",
    execution: { actor: { id: "member", kind: "human", roles: ["member"] }, authority: { capabilities: [], visibility: { kind: "all" }, instructionAuthority: "scoped" }, origin: { kind: "interactive", transport: "discord", conversationId: "conversation" } },
    prompt: "hi",
    inputEvent: { id: "discord:message", occurredAt: "now", identity: { transport: "discord", externalId: "member", principalId: null }, conversation: { transport: "discord", externalId: "channel", kind: "channel" }, content: [{ type: "text", text: "hi" }] },
  });
  assert.match(blocks[0]?.content ?? "", /exactly NO_REPLY/);
  assert.equal(blocks[0]?.instructionAuthority, "scoped");
});

test("current time context is available to every Run with an explicit timezone", async () => {
  const provider = createCurrentTimeContextProvider(() => new Date("2026-09-12T01:02:03.000Z"), "Europe/London");
  const blocks = await provider.load({ runId: "scheduled", execution: {} as never, prompt: "today?" });
  assert.match(blocks[0]?.content ?? "", /2026-09-12T01:02:03\.000Z \(Europe\/London:/);
  assert.equal(blocks[0]?.retention, "essential");
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
