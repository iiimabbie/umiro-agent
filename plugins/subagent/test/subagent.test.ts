import assert from "node:assert/strict";
import test from "node:test";
import type { ExecuteChildRunRequest } from "@umiro/core/delegation";
import { createPlugin } from "../src/index.js";

test("subagent plugin delegates an explicit task package", async () => {
  let request: unknown; let cancellation: unknown;
  let reply: unknown;
  const plugin = createPlugin({ pluginId: "subagent", namespace: "subagent", config: {}, permissionCeiling: { capabilities: ["subagent.delegate"], visibility: { kind: "all" }, instructionAuthority: "none" }, getSecret: () => undefined, services: { childRuns: { async execute(input: ExecuteChildRunRequest) { request = input; return { status: "succeeded", childRunId: "child", text: "done", reused: false }; }, async cancel(parentRunId: string, childRunId: string) { cancellation = [parentRunId, childRunId]; return { cancelled: true, childRunId }; } } as never, replies: { async send(runId, text) { reply = [runId, text]; return { deliveryId: "delivery-middle" }; } } } });
  const tool = plugin.contributions.tools?.[0]!;
  const result = await tool.execute({ objective: "check", prompt: "check it", idempotencyKey: "k", model: "gemma4:31b", constraints: ["bounded"] }, { execution: { origin: { kind: "interactive", transport: "test", conversationId: "run-parent" }, actor: { id: "p", kind: "human", roles: ["owner"] }, authority: { capabilities: ["subagent.delegate"], visibility: { kind: "all" }, instructionAuthority: "full" } }, runId: "run-parent", operationId: "op", idempotencyKey: "k", signal: new AbortController().signal });
  assert.equal(result.ok, true); assert.equal((request as { parentRunId: string }).parentRunId, "run-parent");
  const cancelTool = plugin.contributions.tools?.[1]; assert.ok(cancelTool);
  const cancelled = await cancelTool.execute({ childRunId: "child" }, { execution: { origin: { kind: "interactive", transport: "test", conversationId: "run-parent" }, actor: { id: "p", kind: "human", roles: ["owner"] }, authority: { capabilities: ["subagent.delegate"], visibility: { kind: "all" }, instructionAuthority: "full" } }, runId: "run-parent", operationId: "op-cancel", signal: new AbortController().signal });
  assert.equal(cancelled.ok, true); assert.deepEqual(cancellation, ["run-parent", "child"]);
  const replyTool = plugin.contributions.tools?.[2]; assert.ok(replyTool);
  const replied = await replyTool.execute({ text: "still working" }, { execution: { origin: { kind: "interactive", transport: "test", conversationId: "run-parent" }, actor: { id: "p", kind: "human", roles: ["owner"] }, authority: { capabilities: ["subagent.delegate"], visibility: { kind: "all" }, instructionAuthority: "full" } }, runId: "run-parent", operationId: "op-reply", signal: new AbortController().signal });
  assert.equal(replied.ok, true); assert.deepEqual(reply, ["run-parent", "still working"]);
});
