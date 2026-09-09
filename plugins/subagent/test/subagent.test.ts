import assert from "node:assert/strict";
import test from "node:test";
import type { ExecuteChildRunRequest } from "@umiro/core/delegation";
import { createPlugin } from "../src/index.js";

test("subagent plugin delegates an explicit task package", async () => {
  let request: unknown;
  const plugin = createPlugin({ pluginId: "subagent", namespace: "subagent", config: {}, permissionCeiling: { capabilities: ["subagent.delegate"], visibility: { kind: "all" }, instructionAuthority: "none" }, getSecret: () => undefined, services: { childRuns: { async execute(input: ExecuteChildRunRequest) { request = input; return { status: "succeeded", childRunId: "child", text: "done", reused: false }; } } as never } });
  const tool = plugin.contributions.tools?.[0]!;
  const result = await tool.execute({ objective: "check", prompt: "check it", idempotencyKey: "k", model: "gemma4:31b", constraints: ["bounded"] }, { execution: { origin: { kind: "interactive", transport: "test", conversationId: "run-parent" }, actor: { id: "p", kind: "human", roles: ["owner"] }, authority: { capabilities: ["subagent.delegate"], visibility: { kind: "all" }, instructionAuthority: "full" } }, runId: "run-parent", operationId: "op", idempotencyKey: "k", signal: new AbortController().signal });
  assert.equal(result.ok, true); assert.equal((request as { parentRunId: string }).parentRunId, "run-parent");
});
