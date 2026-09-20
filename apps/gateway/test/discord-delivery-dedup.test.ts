import assert from "node:assert/strict";
import test from "node:test";
import type { DeliveryIntent, ExecutionStore, Operation, OperationResult } from "@umiro/core";
import { duplicateDiscordSendEvidence } from "../src/discord-delivery-dedup.js";

const intent = (extra: Partial<DeliveryIntent> = {}): DeliveryIntent => ({
  id: "delivery",
  runId: "run",
  destination: { kind: "discord", channelId: "channel" },
  payload: { text: "hello" },
  state: "pending",
  createdAt: "now",
  ...extra,
});

const operation: Operation = {
  id: "operation",
  stepId: "step",
  kind: "tool:discord_send_message",
  input: { channelId: "channel", content: "hello" },
  state: "succeeded",
  capability: "discord.message.write",
  authorizationTier: "common",
  sideEffect: "non_idempotent",
  createdAt: "now",
  updatedAt: "now",
};

const result: OperationResult = {
  operationId: operation.id,
  outcome: "succeeded",
  effectStatus: "confirmed",
  output: { messageId: "message" },
  completedAt: "now",
};

function store(currentOperation: Operation = operation, currentResult: OperationResult | undefined = result): Pick<ExecutionStore, "listOperations" | "getOperationResult"> {
  return {
    async listOperations() { return [currentOperation]; },
    async getOperationResult() { return currentResult; },
  };
}

test("deduplicates a confirmed same-run send to the same Discord channel", async () => {
  assert.deepEqual(await duplicateDiscordSendEvidence(store(), intent()), {
    transport: "discord",
    channelId: "channel",
    messageId: "message",
    messageIds: ["message"],
    skipped: "duplicate_tool_delivery",
    operationId: "operation",
  });
});

test("does not suppress different, unconfirmed, or attachment deliveries", async () => {
  assert.equal(await duplicateDiscordSendEvidence(store({ ...operation, input: { channelId: "other", content: "hello" } }), intent()), undefined);
  assert.equal(await duplicateDiscordSendEvidence(store({ ...operation, input: { channelId: "channel", content: "different" } }), intent()), undefined);
  assert.equal(await duplicateDiscordSendEvidence(store(operation, { ...result, effectStatus: "unknown", outcome: "outcome_unknown" }), intent()), undefined);
  assert.equal(await duplicateDiscordSendEvidence(store(), intent({ payload: { text: "hello", artifactIds: ["artifact"] } })), undefined);
});
