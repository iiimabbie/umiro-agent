import assert from "node:assert/strict";
import test from "node:test";
import { capabilities, type DiscordPluginService, type ExecutionContext, type PluginSetupContext } from "@umiro/core";
import { createPlugin } from "../src/index.js";

const context: ExecutionContext = { actor: { id: "owner", kind: "human", roles: ["owner"] }, origin: { kind: "interactive", transport: "discord", conversationId: "c" }, authority: { capabilities: capabilities("discord.message.write", "discord.message.react", "discord.message.pin", "discord.message.read"), visibility: { kind: "all" }, instructionAuthority: "full" } };

test("registers protocol-neutral Discord tools and delegates with explicit resources", async () => {
  const calls: string[] = [];
  const discord: DiscordPluginService = { async sendMessage(input) { calls.push(`send:${input.channelId}`); return { messageId: "123456" }; }, async react(input) { calls.push(`react:${input.messageId}`); }, async pin(input) { calls.push(`pin:${input.messageId}`); }, async unpin(input) { calls.push(`unpin:${input.messageId}`); }, async fetchMessage(input) { calls.push(`fetch:${input.messageId}`); return { messageId: input.messageId, channelId: input.channelId, authorId: "42", content: "hello", createdAt: "2026-09-10T00:00:00.000Z" }; }, async createThread(input) { calls.push(`thread:${input.channelId}`); return { threadId: "123456" }; }, async createForumPost(input) { calls.push(`forum:${input.channelId}`); return { threadId: "123456" }; }, async archiveThread(input) { calls.push(`archive:${input.threadId}`); }, async deleteThread(input) { calls.push(`delete-thread:${input.threadId}`); }, async editMessage(input) { calls.push(`edit:${input.messageId}`); }, async deleteMessage(input) { calls.push(`delete:${input.messageId}`); }, async fetchChannelMessages(input) { calls.push(`history:${input.channelId}`); return []; } };
  const setup = { pluginId: "discord-tools", namespace: "discord-tools", permissionCeiling: context.authority, config: {}, services: { discord } } as unknown as PluginSetupContext;
  const plugin = createPlugin(setup);
  assert.deepEqual(plugin.contributions.tools?.map(tool => tool.name), ["discord_send_message", "discord_react", "discord_pin", "discord_unpin", "discord_fetch_message", "discord_create_thread", "discord_create_forum_post", "discord_archive_thread", "discord_delete_thread", "discord_edit_message", "discord_delete_message", "discord_fetch_channel_messages"]);
  const react = plugin.contributions.tools?.find(tool => tool.name === "discord_react");
  assert.ok(react);
  const result = await react.execute({ channelId: "123456", messageId: "654321", emoji: "👍" }, { execution: context, operationId: "op", signal: new AbortController().signal });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["react:654321"]);
});
