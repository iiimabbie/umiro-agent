import assert from "node:assert/strict";
import test from "node:test";
import { analyzeDiscordIngress } from "../src/ingress-analysis.js";

const analysis = (shouldReply: boolean) => ({ shouldReply, selectedToolNames: [], contextBlocks: [] });

test("hard-ignore does not call the analyzer", async () => {
  let calls = 0;
  const route = await analyzeDiscordIngress({ decision: { disposition: "ignore", reason: "ignored_channel" }, text: "hello", analyze: async () => { calls += 1; return analysis(true); } });
  assert.deepEqual(route, { kind: "ignore" });
  assert.equal(calls, 0);
});

for (const reason of ["mention", "owner_dm", "reply_to_bot"] as const) {
  test(`${reason} plus analyzer shouldReply=false is observed without a Run`, async () => {
    let calls = 0;
    const route = await analyzeDiscordIngress({ decision: { disposition: "trigger", reason }, text: "ambient", analyze: async () => { calls += 1; return analysis(false); } });
    assert.deepEqual(route, { kind: "observe", analysis: analysis(false) });
    assert.equal(calls, 1);
  });
}

test("observe plus analyzer shouldReply=true becomes a single trigger", async () => {
  let calls = 0;
  const route = await analyzeDiscordIngress({ decision: { disposition: "observe", reason: "allowed_untriggered_message" }, text: "please help", analyze: async () => { calls += 1; return analysis(true); } });
  assert.deepEqual(route, { kind: "trigger", analysis: analysis(true) });
  assert.equal(calls, 1);
});

test("analyzer failure falls back to the deterministic policy", async () => {
  let calls = 0;
  const observe = await analyzeDiscordIngress({ decision: { disposition: "observe", reason: "allowed_untriggered_message" }, text: "hello", analyze: async () => { calls += 1; throw new Error("timeout"); } });
  const trigger = await analyzeDiscordIngress({ decision: { disposition: "trigger", reason: "mention" }, text: "hello", analyze: async () => { calls += 1; throw new Error("timeout"); } });
  assert.deepEqual(observe, { kind: "observe" });
  assert.deepEqual(trigger, { kind: "trigger" });
  assert.equal(calls, 2);
});

test("attachment-only messages skip analysis and keep the trigger policy", async () => {
  let calls = 0;
  const route = await analyzeDiscordIngress({ decision: { disposition: "trigger", reason: "mention" }, text: "   ", analyze: async () => { calls += 1; return analysis(false); } });
  assert.deepEqual(route, { kind: "trigger" });
  assert.equal(calls, 0);
});
