import type { ConversationStore, PluginConversationHistoryService } from "@umiro/core";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function localDate(value: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(candidate => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function text(content: readonly ({ readonly type: string; readonly text?: string })[]): string {
  return content.filter(block => block.type === "text").map(block => block.text ?? "").join("\n").trim();
}

function clean(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/^\[System\].*$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}

export class PluginConversationHistory implements PluginConversationHistoryService {
  constructor(private readonly store: ConversationStore) {}

  async transcriptByDate(input: { readonly date: string; readonly timezone: string; readonly maxCharacters?: number }) {
    if (!DATE.test(input.date)) throw new TypeError("date must use YYYY-MM-DD");
    const parsed = new Date(`${input.date}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== input.date) throw new TypeError("date is not a real calendar date");
    try { new Intl.DateTimeFormat("en-US", { timeZone: input.timezone }).format(); }
    catch { throw new TypeError(`invalid IANA timezone: ${input.timezone}`); }
    const maxCharacters = input.maxCharacters ?? 80_000;
    if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 1_000 || maxCharacters > 500_000) throw new TypeError("maxCharacters must be between 1000 and 500000");

    const summaries = await this.store.listConversations({ limit: 200 });
    const groups: Array<{ readonly firstAt: string; readonly lines: readonly string[] }> = [];
    let messageCount = 0;
    for (const summary of summaries) {
      const messages = [];
      let after: number | undefined;
      while (true) {
        const page = await this.store.listConversationMessages(summary.conversation.id, 500, after);
        if (!page?.messages.length) break;
        messages.push(...page.messages);
        if (!page.hasMore) break;
        after = page.messages.at(-1)!.turn.sequence;
      }
      const events: Array<{ readonly at: string; readonly speaker: string; readonly value: string }> = [];
      for (const item of messages) {
        const userText = clean(text(item.turn.content));
        if (userText && localDate(item.turn.createdAt, input.timezone) === input.date) events.push({ at: item.turn.createdAt, speaker: item.actorDisplayName ?? item.turn.actorPrincipalId, value: userText });
        const assistantText = item.reply?.state === "succeeded" && item.reply.text ? clean(item.reply.text) : "";
        if (assistantText && localDate(item.reply!.at, input.timezone) === input.date) events.push({ at: item.reply!.at, speaker: "Assistant", value: assistantText });
      }
      if (!events.length) continue;
      events.sort((left, right) => left.at.localeCompare(right.at));
      messageCount += events.length;
      groups.push({ firstAt: events[0]!.at, lines: events.flatMap(event => [`${event.speaker}:`, event.value, ""]) });
    }
    groups.sort((left, right) => left.firstAt.localeCompare(right.firstAt));
    const sections = groups.map((group, index) => [`## Conversation ${index + 1}`, "", ...group.lines].join("\n").trimEnd());
    const complete = sections.join("\n\n").trim();
    if (complete.length <= maxCharacters) return { date: input.date, timezone: input.timezone, conversations: groups.length, messages: messageCount, text: complete || "No journal-worthy conversation found.", truncated: summaries.length === 200 };
    const suffix = "\n\n[Transcript truncated at configured character limit.]";
    const prefix = complete.slice(0, Math.max(0, maxCharacters - suffix.length)).replace(/\n[^\n]*$/, "");
    return { date: input.date, timezone: input.timezone, conversations: groups.length, messages: messageCount, text: `${prefix}${suffix}`, truncated: true };
  }
}
