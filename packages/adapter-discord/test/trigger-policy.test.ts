import assert from "node:assert/strict";
import test from "node:test";
import { decideDiscordIngress, parseDiscordTriggerPolicy } from "../src/trigger-policy.js";

const base = { channelId: "channel-a", guildId: "guild-a", authorId: "member", authorBot: false, botMentioned: false, replyToBot: false } as const;
const config = parseDiscordTriggerPolicy({
  ignoredChannels: ["ignored"],
  ambientChannels: ["ambient"],
  allowedChannels: ["channel-a", "ambient"],
  allowedGuilds: ["guild-a"],
  respondToBots: false,
});

test("Discord trigger policy applies ignore, observe, and trigger without conflating recording and replies", () => {
  assert.deepEqual(decideDiscordIngress({ ...base, channelId: "ignored", authorId: "owner", botMentioned: true }, config, "owner"), { disposition: "ignore", reason: "ignored_channel" });
  assert.equal(decideDiscordIngress(base, config, "owner").disposition, "observe");
  assert.equal(decideDiscordIngress({ ...base, botMentioned: true }, config, "owner").disposition, "trigger");
  assert.equal(decideDiscordIngress({ ...base, channelId: "ambient" }, config, "owner").disposition, "trigger");
  assert.deepEqual(decideDiscordIngress({ ...base, guildId: "other", botMentioned: true }, config, "owner"), { disposition: "ignore", reason: "guild_not_allowed" });
});

test("Discord trigger policy protects DMs and bot traffic while Owner remains subject to guild scope", () => {
  assert.deepEqual(decideDiscordIngress({ ...base, guildId: "other", authorId: "owner", botMentioned: true }, config, "owner"), { disposition: "ignore", reason: "guild_not_allowed" });
  assert.deepEqual(decideDiscordIngress({ ...base, channelId: "other", authorId: "owner", botMentioned: true }, config, "owner"), { disposition: "ignore", reason: "channel_not_allowed" });
  assert.equal(decideDiscordIngress({ ...base, authorId: "owner", botMentioned: true }, config, "owner").disposition, "trigger");
  const { guildId: _guildId, ...direct } = base;
  assert.deepEqual(decideDiscordIngress({ ...direct, authorId: "member" }, config, "owner"), { disposition: "ignore", reason: "non_owner_dm" });
  assert.equal(decideDiscordIngress({ ...direct, authorId: "owner" }, config, "owner").disposition, "trigger");
  assert.deepEqual(decideDiscordIngress({ ...base, authorBot: true, botMentioned: true }, config, "owner"), { disposition: "ignore", reason: "bot_messages_disabled" });
  assert.equal(decideDiscordIngress({ ...base, authorBot: true, botMentioned: true }, { ...config, respondToBots: true }, "owner").disposition, "trigger");
});

test("Discord trigger config is strict and empty allowlists retain V1 unrestricted semantics", () => {
  const defaults = parseDiscordTriggerPolicy(undefined);
  assert.equal(defaults.respondToBots, true);
  assert.equal(defaults.queueMode, "followup");
  assert.equal(decideDiscordIngress({ ...base, botMentioned: true }, defaults, "owner").disposition, "trigger");
  assert.deepEqual(parseDiscordTriggerPolicy({ presence: { status: "dnd", activity: "helping" } }).presence, { status: "dnd", activity: "helping" });
  assert.equal(parseDiscordTriggerPolicy({ queueMode: "steer" }).queueMode, "steer");
  assert.throws(() => parseDiscordTriggerPolicy({ queueMode: "parallel" }));
  assert.throws(() => parseDiscordTriggerPolicy({ allowedGuilds: "guild-a" }));
  assert.throws(() => parseDiscordTriggerPolicy({ presence: { status: "away" } }));
  assert.throws(() => parseDiscordTriggerPolicy({ surprise: true }));
});
