import assert from "node:assert/strict";
import test from "node:test";
import { analyzeDiscordIngress, buildDiscordAnalysisText, includeSubagentWaitForSelectedDelegate } from "../src/ingress-analysis.js";

const analysis = (shouldReply: boolean) => ({ shouldReply, selectedToolNames: [], contextBlocks: [] });

test("analysis text includes bounded recent context before the current message", () => {
  const text = buildDiscordAnalysisText("你編輯一下", [
    { userText: "我已經直接編輯文檔了，你去看一下並整理。", assistantText: "請告訴我要處理哪個檔案。" },
  ]);
  assert.match(text, /User: 我已經直接編輯文檔了/);
  assert.match(text, /Assistant: 請告訴我要處理哪個檔案/);
  assert.ok(text.endsWith("Current message:\n你編輯一下"));
  assert.ok(text.length <= 10_000);
});

test("analysis text remains unchanged without conversation history", () => {
  assert.equal(buildDiscordAnalysisText("  hello  ", []), "  hello  ");
});

test("selected delegation includes the registered wait tool without changing existing order", () => {
  assert.deepEqual(includeSubagentWaitForSelectedDelegate(["reply_now", "subagent_delegate", "web_search"], true), ["reply_now", "subagent_delegate", "subagent_wait", "web_search"]);
  assert.deepEqual(includeSubagentWaitForSelectedDelegate(["reply_now", "subagent_delegate", "subagent_wait", "web_search"], true), ["reply_now", "subagent_delegate", "subagent_wait", "web_search"]);
  assert.deepEqual(includeSubagentWaitForSelectedDelegate(["reply_now", "subagent_delegate", "reply_now"], true), ["reply_now", "subagent_delegate", "subagent_wait"]);
  assert.deepEqual(includeSubagentWaitForSelectedDelegate(["reply_now", "web_search"], true), ["reply_now", "web_search"]);
  assert.deepEqual(includeSubagentWaitForSelectedDelegate(["reply_now", "subagent_delegate"], false), ["reply_now", "subagent_delegate"]);
});

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

test("observe remains observe without consulting the analyzer", async () => {
  let calls = 0;
  const route = await analyzeDiscordIngress({ decision: { disposition: "observe", reason: "allowed_untriggered_message" }, text: "please help", analyze: async () => { calls += 1; return analysis(true); } });
  assert.deepEqual(route, { kind: "observe" });
  assert.equal(calls, 0);
});

test("analyzer failure falls back to the deterministic policy", async () => {
  let calls = 0;
  const observe = await analyzeDiscordIngress({ decision: { disposition: "observe", reason: "allowed_untriggered_message" }, text: "hello", analyze: async () => { calls += 1; throw new Error("timeout"); } });
  const trigger = await analyzeDiscordIngress({ decision: { disposition: "trigger", reason: "mention" }, text: "hello", analyze: async () => { calls += 1; throw new Error("timeout"); } });
  assert.deepEqual(observe, { kind: "observe" });
  assert.deepEqual(trigger, { kind: "trigger" });
  assert.equal(calls, 1);
});

test("attachment-only messages skip analysis and keep the trigger policy", async () => {
  let calls = 0;
  const route = await analyzeDiscordIngress({ decision: { disposition: "trigger", reason: "mention" }, text: "   ", analyze: async () => { calls += 1; return analysis(false); } });
  assert.deepEqual(route, { kind: "trigger" });
  assert.equal(calls, 0);
});
