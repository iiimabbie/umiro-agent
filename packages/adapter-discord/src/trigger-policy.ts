export type DiscordIngressDisposition = "ignore" | "observe" | "trigger";

export interface DiscordTriggerPolicyConfig {
  readonly ignoredChannels?: readonly string[];
  readonly ambientChannels?: readonly string[];
  readonly allowedChannels?: readonly string[];
  readonly allowedGuilds?: readonly string[];
  readonly respondToBots?: boolean;
  readonly queueMode?: "queue" | "steer";
  readonly presence?: DiscordPresenceConfig;
}

export interface DiscordPresenceConfig {
  readonly status?: "online" | "idle" | "dnd" | "invisible";
  readonly activity?: string;
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
  if (value === undefined) return { ignoredChannels: [], ambientChannels: [], allowedChannels: [], allowedGuilds: [], respondToBots: true, queueMode: "queue" };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("discord config must be an object");
  const raw = value as Record<string, unknown>;
  const allowed = new Set(["ignoredChannels", "ambientChannels", "allowedChannels", "allowedGuilds", "respondToBots", "queueMode", "presence"]);
  const unexpected = Object.keys(raw).find(key => !allowed.has(key));
  if (unexpected) throw new TypeError(`unsupported discord config field: ${unexpected}`);
  if (raw.respondToBots !== undefined && typeof raw.respondToBots !== "boolean") throw new TypeError("discord.respondToBots must be boolean");
  if (raw.queueMode !== undefined && raw.queueMode !== "queue" && raw.queueMode !== "steer") throw new TypeError("discord.queueMode must be queue or steer");
  if (raw.presence !== undefined && (!raw.presence || typeof raw.presence !== "object" || Array.isArray(raw.presence))) throw new TypeError("discord.presence must be an object");
  const presence = raw.presence as Record<string, unknown> | undefined;
  if (presence) {
    const unexpectedPresence = Object.keys(presence).find(key => key !== "status" && key !== "activity");
    if (unexpectedPresence) throw new TypeError(`unsupported discord.presence field: ${unexpectedPresence}`);
    if (presence.status !== undefined && presence.status !== "online" && presence.status !== "idle" && presence.status !== "dnd" && presence.status !== "invisible") throw new TypeError("discord.presence.status must be online, idle, dnd, or invisible");
    if (presence.activity !== undefined && (typeof presence.activity !== "string" || !presence.activity.trim())) throw new TypeError("discord.presence.activity must be a non-empty string");
  }
  const normalizedPresence: DiscordPresenceConfig | undefined = presence
    ? { ...(presence.status !== undefined ? { status: presence.status as NonNullable<DiscordPresenceConfig["status"]> } : {}), ...(typeof presence.activity === "string" ? { activity: presence.activity.trim() } : {}) }
    : undefined;
  return {
    ignoredChannels: stringList(raw.ignoredChannels, "ignoredChannels"),
    ambientChannels: stringList(raw.ambientChannels, "ambientChannels"),
    allowedChannels: stringList(raw.allowedChannels, "allowedChannels"),
    allowedGuilds: stringList(raw.allowedGuilds, "allowedGuilds"),
    respondToBots: raw.respondToBots !== false,
    queueMode: raw.queueMode === "steer" ? "steer" : "queue",
    ...(normalizedPresence ? { presence: normalizedPresence } : {}),
  };
}

/** Pure policy: adapters provide transport facts; authorization remains in Core. */
export function decideDiscordIngress(
  facts: DiscordTriggerFacts,
  config: DiscordTriggerPolicyConfig,
  ownerDiscordId: string,
): DiscordTriggerDecision {
  // Discord threads are independent policy scopes. Lists match the exact
  // channel/thread ID and intentionally do not inherit the parent channel.
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
