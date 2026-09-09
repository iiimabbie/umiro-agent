export type DiscordIngressDisposition = "ignore" | "observe" | "trigger";

export interface DiscordTriggerPolicyConfig {
  readonly ignoredChannels?: readonly string[];
  readonly ambientChannels?: readonly string[];
  readonly allowedChannels?: readonly string[];
  readonly allowedGuilds?: readonly string[];
  readonly respondToBots?: boolean;
}

export interface DiscordTriggerFacts {
  readonly channelId: string;
  readonly guildId?: string;
  readonly authorId: string;
  readonly authorBot: boolean;
  readonly botMentioned: boolean;
  readonly replyToBot: boolean;
}

export interface DiscordTriggerDecision {
  readonly disposition: DiscordIngressDisposition;
  readonly reason: string;
}

function stringList(value: unknown, name: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item.trim())) {
    throw new TypeError(`discord.${name} must be an array of non-empty strings`);
  }
  return [...new Set(value.map(item => item.trim()))];
}

export function parseDiscordTriggerPolicy(value: unknown): DiscordTriggerPolicyConfig {
  if (value === undefined) return { ignoredChannels: [], ambientChannels: [], allowedChannels: [], allowedGuilds: [], respondToBots: false };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("discord config must be an object");
  const raw = value as Record<string, unknown>;
  const allowed = new Set(["ignoredChannels", "ambientChannels", "allowedChannels", "allowedGuilds", "respondToBots"]);
  const unexpected = Object.keys(raw).find(key => !allowed.has(key));
  if (unexpected) throw new TypeError(`unsupported discord config field: ${unexpected}`);
  if (raw.respondToBots !== undefined && typeof raw.respondToBots !== "boolean") throw new TypeError("discord.respondToBots must be boolean");
  return {
    ignoredChannels: stringList(raw.ignoredChannels, "ignoredChannels"),
    ambientChannels: stringList(raw.ambientChannels, "ambientChannels"),
    allowedChannels: stringList(raw.allowedChannels, "allowedChannels"),
    allowedGuilds: stringList(raw.allowedGuilds, "allowedGuilds"),
    respondToBots: raw.respondToBots === true,
  };
}

/** Pure policy: adapters provide transport facts; authorization remains in Core. */
export function decideDiscordIngress(
  facts: DiscordTriggerFacts,
  config: DiscordTriggerPolicyConfig,
  ownerDiscordId: string,
): DiscordTriggerDecision {
  const ignored = new Set(config.ignoredChannels ?? []);
  if (ignored.has(facts.channelId)) return { disposition: "ignore", reason: "ignored_channel" };
  if (facts.authorBot && config.respondToBots !== true) return { disposition: "ignore", reason: "bot_messages_disabled" };

  const owner = facts.authorId === ownerDiscordId;
  if (!facts.guildId) return owner
    ? { disposition: "trigger", reason: "owner_dm" }
    : { disposition: "ignore", reason: "non_owner_dm" };

  const ambient = (config.ambientChannels ?? []).includes(facts.channelId);
  const triggered = ambient || facts.botMentioned || facts.replyToBot;
  const allowedGuilds = config.allowedGuilds ?? [];
  if (allowedGuilds.length > 0 && !allowedGuilds.includes(facts.guildId)) return { disposition: "ignore", reason: "guild_not_allowed" };
  const allowedChannels = config.allowedChannels ?? [];
  if (!ambient && allowedChannels.length > 0 && !allowedChannels.includes(facts.channelId)) {
    return { disposition: "ignore", reason: "channel_not_allowed" };
  }
  if (triggered) return { disposition: "trigger", reason: ambient ? "ambient_channel" : (facts.botMentioned ? "mention" : "reply_to_bot") };
  return { disposition: "observe", reason: "allowed_untriggered_message" };
}
