import type { ModelMessage } from "../model/contract.js";
import type { ConversationHistoryItem } from "./entities.js";

/** Projects canonical history into native model turns. Tool evidence is
 * intentionally not represented as provider tool messages. */
export function conversationHistoryToMessages(items: readonly ConversationHistoryItem[]): ModelMessage[] {
  const messages: ModelMessage[] = [];
  for (const item of items) {
    const { turn } = item;
    const text = turn.content.map(block => block.type === "text" ? block.text : `[attachment:${block.artifactId}]`).join("\n").trim();
    if (!text) continue;
    const externalId = turn.actorIdentity?.externalId;
    const speaker = item.actorDisplayName ?? externalId ?? turn.actorPrincipalId;
    const identity = externalId ? `<@${externalId}>(${speaker})` : `${speaker} [principal:${turn.actorPrincipalId}]`;
    const prefix = turn.primaryRunId ? "" : "[context] ";
    messages.push({ role: "user", content: `${prefix}[msg:${turn.inputEventId} ${turn.createdAt}] ${identity}: ${text}` });
    if (item.assistantText !== undefined && item.assistantText.trim()) messages.push({ role: "assistant", content: item.assistantText });
  }
  return messages;
}
