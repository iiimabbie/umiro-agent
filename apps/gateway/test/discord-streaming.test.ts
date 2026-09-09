import assert from "node:assert/strict";
import test from "node:test";
import { DiscordStreamingDelivery } from "../src/discord-streaming.js";

test("Discord streaming edits a transient message then confirms the durable delivery", async () => {
  const edits: string[] = []; const delivered: unknown[] = []; let clock = 0;
  const streaming = new DiscordStreamingDelivery("channel", {
    async sendText(_channel, text) { edits.push(text); return { messageId: "message" }; },
    async editText(_channel, _message, text) { edits.push(text); return { messageId: "message" }; },
  }, { async markDeliveryDelivered(...args: unknown[]) { delivered.push(args); } }, () => clock);
  await streaming.delta("Hel"); clock = 800; await streaming.delta("lo");
  assert.equal(await streaming.finalize("delivery", "Hello", "2026-09-09T00:00:00.000Z"), true);
  assert.deepEqual(edits, ["Hel", "Hello", "Hello"]);
  assert.equal(delivered.length, 1);
});

test("Discord streaming failure degrades to the ordinary pending delivery path", async () => {
  let failures = 0;
  const streaming = new DiscordStreamingDelivery("channel", { async sendText() { throw new Error("offline"); }, async editText() { throw new Error("unused"); } }, { async markDeliveryDelivered() { throw new Error("unused"); } }, Date.now, () => failures++);
  await streaming.delta("partial");
  assert.equal(await streaming.finalize("delivery", "final", "2026-09-09T00:00:00.000Z"), false);
  assert.equal(failures, 1);
});
