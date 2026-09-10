import assert from "node:assert/strict";
import test from "node:test";
import type { ExecuteChildRunRequest } from "@umiro/core/delegation";
import { createPlugin } from "../src/index.js";

test("subagent plugin delegates an explicit task package", async () => {
  let request: unknown; let cancellation: unknown;
  let reply: unknown;
  const plugin = createPlugin({ pluginId: "subagent", namespace: "subagent", config: {}, permissionCeiling: { capabilities: ["subagent.delegate"], visibility: { kind: "all" }, instructionAuthority: "none" }, getSecret: () => undefined, services: { childRuns: { async start(input: ExecuteChildRunRequest) { request = input; return { status: "active", childRunId: "child" }; }, async waitForAny(parentRunId: string, childRunIds: readonly string[]) { return { status: "succeeded", childRunId: childRunIds[0] ?? "child", text: parentRunId, reused: false }; }, async cancel(parentRunId: string, childRunId: string) { cancellation = [parentRunId, childRunId]; return { cancelled: true, childRunId }; } } as never, replies: { async send(runId, text) { reply = [runId, text]; return { deliveryId: "delivery-middle" }; } } } });
  const tool = plugin.contributions.tools?.[0]!;
  const result = await tool.execute({ objective: "check", prompt: "check it", idempotencyKey: "k", model: "gemma4:31b", constraints: ["bounded"] }, { execution: { origin: { kind: "interactive", transport: "test", conversationId: "run-parent" }, actor: { id: "p", kind: "human", roles: ["owner"] }, authority: { capabilities: ["subagent.delegate"], visibility: { kind: "all" }, instructionAuthority: "full" } }, runId: "run-parent", operationId: "op", idempotencyKey: "k", signal: new AbortController().signal });
  assert.equal(result.ok, true); assert.equal((request as { parentRunId: string }).parentRunId, "run-parent");
  const waitTool = plugin.contributions.tools?.[1]; assert.ok(waitTool);
  const waited = await waitTool.execute({ childRunIds: ["child"] }, { execution: { origin: { kind: "interactive", transport: "test", conversationId: "run-parent" }, actor: { id: "p", kind: "human", roles: ["owner"] }, authority: { capabilities: ["subagent.delegate"], visibility: { kind: "all" }, instructionAuthority: "full" } }, runId: "run-parent", operationId: "op-wait", signal: new AbortController().signal });
  assert.equal(waited.ok, true);
  const cancelTool = plugin.contributions.tools?.[2]; assert.ok(cancelTool);
  const cancelled = await cancelTool.execute({ childRunId: "child" }, { execution: { origin: { kind: "interactive", transport: "test", conversationId: "run-parent" }, actor: { id: "p", kind: "human", roles: ["owner"] }, authority: { capabilities: ["subagent.delegate"], visibility: { kind: "all" }, instructionAuthority: "full" } }, runId: "run-parent", operationId: "op-cancel", signal: new AbortController().signal });
  assert.equal(cancelled.ok, true); assert.deepEqual(cancellation, ["run-parent", "child"]);
  const replyTool = plugin.contributions.tools?.[3]; assert.ok(replyTool);
  const replied = await replyTool.execute({ text: "still working" }, { execution: { origin: { kind: "interactive", transport: "test", conversationId: "run-parent" }, actor: { id: "p", kind: "human", roles: ["owner"] }, authority: { capabilities: ["subagent.delegate"], visibility: { kind: "all" }, instructionAuthority: "full" } }, runId: "run-parent", operationId: "op-reply", signal: new AbortController().signal });
  assert.equal(replied.ok, true); assert.deepEqual(reply, ["run-parent", "still working"]);
});

test("subagent profile compiles static instructions and narrows supervisor choices", async () => {
  let request: ExecuteChildRunRequest | undefined;
  const coder = { id: "coder", description: "code", instructions: ["You are a careful coder.", "Return verified changes."], model: "fast", authorityScope: { capabilities: ["filesystem.read" as const] }, budgetCeiling: { maxModelTurns: 3, maxToolCalls: 2 }, outputContract: { kind: "text" as const } };
  const plugin = createPlugin({ pluginId: "subagent", namespace: "subagent", config: {}, permissionCeiling: { capabilities: ["subagent.delegate"], visibility: { kind: "all" }, instructionAuthority: "none" }, getSecret: () => undefined, services: { subagentProfiles: { list: () => [coder], get: id => id === "coder" ? coder : undefined }, childRuns: { async start(input: ExecuteChildRunRequest) { request = input; return { status: "active", childRunId: "child" }; }, async waitForAny() { throw new Error("unused"); }, async cancel() { return { cancelled: false, childRunId: "child" }; } } as never, replies: { async send() { return { deliveryId: "d" }; } } } });
  const delegate = plugin.contributions.tools![0]!;
  const context = { execution: { origin: { kind: "interactive" as const, transport: "test", conversationId: "c" }, actor: { id: "owner", kind: "human" as const, roles: ["owner" as const] }, authority: { capabilities: ["subagent.delegate" as const], visibility: { kind: "all" as const }, instructionAuthority: "full" as const } }, runId: "parent", operationId: "op", signal: new AbortController().signal };
  const result = await delegate.execute({ profile: "coder", objective: "fix it", idempotencyKey: "k", constraints: ["small"], acceptanceCriteria: ["tests pass"], authorityScope: { capabilities: ["filesystem.read", "filesystem.write"] }, budgetCeiling: { maxModelTurns: 5, maxToolCalls: 1 } }, context);
  assert.equal(result.ok, true);
  assert.equal(request?.model, "fast");
  assert.deepEqual(request?.authorityScope.capabilities, ["filesystem.read"]);
  assert.deepEqual(request?.budgetCeiling, { maxModelTurns: 3, maxToolCalls: 1 });
  assert.match(request?.prompt ?? "", /^You are a careful coder\.\nReturn verified changes\.[\s\S]*Objective:\nfix it[\s\S]*tests pass/);
  assert.equal(request?.task.outputContract.kind, "text");
  const conflict = await delegate.execute({ profile: "coder", objective: "x", idempotencyKey: "k2", model: "other" }, context);
  assert.equal(conflict.ok, false); if (!conflict.ok) assert.match(conflict.error.message, /cannot be overridden/);
  const unknown = await delegate.execute({ profile: "missing", objective: "x", idempotencyKey: "k3" }, context);
  assert.equal(unknown.ok, false); if (!unknown.ok) assert.match(unknown.error.message, /available profiles: coder/);
  const incomplete = await delegate.execute({ objective: "x", idempotencyKey: "k4" }, context);
  assert.equal(incomplete.ok, false); if (!incomplete.ok) assert.match(incomplete.error.message, /profile, or both prompt and model/);
  const flexible = { id: "flexible", description: coder.description, instructions: coder.instructions, authorityScope: coder.authorityScope, budgetCeiling: coder.budgetCeiling, outputContract: coder.outputContract };
  const flexiblePlugin = createPlugin({ pluginId: "subagent", namespace: "subagent", config: {}, permissionCeiling: { capabilities: ["subagent.delegate"], visibility: { kind: "all" }, instructionAuthority: "none" }, getSecret: () => undefined, services: { subagentProfiles: { list: () => [flexible], get: id => id === "flexible" ? flexible : undefined }, childRuns: { async start(input: ExecuteChildRunRequest) { request = input; return { status: "active", childRunId: "child" }; }, async waitForAny() { throw new Error("unused"); }, async cancel() { return { cancelled: false, childRunId: "child" }; } } as never, replies: { async send() { return { deliveryId: "d" }; } } } });
  const missingModel = await flexiblePlugin.contributions.tools![0]!.execute({ profile: "flexible", objective: "x", idempotencyKey: "k5" }, context);
  assert.equal(missingModel.ok, false); if (!missingModel.ok) assert.match(missingModel.error.message, /model is required/);
  const withModel = await flexiblePlugin.contributions.tools![0]!.execute({ profile: "flexible", objective: "x", idempotencyKey: "k6", model: "fast" }, context);
  assert.equal(withModel.ok, true); assert.equal(request?.model, "fast");
});
