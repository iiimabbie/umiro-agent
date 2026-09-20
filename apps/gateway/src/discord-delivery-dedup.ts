import type { DeliveryIntent, ExecutionStore, JsonObject } from "@umiro/core";

type DedupStore = Pick<ExecutionStore, "listOperations" | "getOperationResult">;

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export async function duplicateDiscordSendEvidence(store: DedupStore, intent: DeliveryIntent): Promise<JsonObject | undefined> {
  if (intent.destination.kind !== "discord" || typeof intent.destination.channelId !== "string") return undefined;
  if (typeof intent.payload.text !== "string" || Array.isArray(intent.payload.artifactIds) && intent.payload.artifactIds.length > 0) return undefined;
  const operations = await store.listOperations(intent.runId);
  for (const operation of operations.slice().reverse()) {
    if (operation.kind !== "tool:discord_send_message" || operation.state !== "succeeded") continue;
    if (operation.input.channelId !== intent.destination.channelId || operation.input.content !== intent.payload.text) continue;
    const result = await store.getOperationResult(operation.id);
    if (result?.outcome !== "succeeded" || result.effectStatus !== "confirmed") continue;
    const output = object(result.output);
    if (typeof output?.messageId !== "string") continue;
    return {
      transport: "discord",
      channelId: intent.destination.channelId,
      messageId: output.messageId,
      messageIds: [output.messageId],
      skipped: "duplicate_tool_delivery",
      operationId: operation.id,
    };
  }
  return undefined;
}
