import assert from "node:assert/strict";
import test from "node:test";
import { createPlugin } from "../src/index.js";

test("cron tool creates a channel-optional agent trigger with caller authority", async () => {
  const created: unknown[] = [];
  const plugin = createPlugin({ pluginId: "scheduler", namespace: "scheduler", config: { timezone: "Europe/London" }, permissionCeiling: { capabilities: ["scheduler.read", "scheduler.write", "scheduler.remove"], visibility: { kind: "all" }, instructionAuthority: "none" }, getSecret: () => undefined, services: { scheduler: { async create(input, key) { created.push({ input, key }); return { ...input, id: "id", revision: 0, nextFireAt: "next", createdAt: "now", updatedAt: "now" }; }, async list() { return []; }, async setEnabled() { throw new Error("unused"); }, async update() { throw new Error("unused"); }, async remove() { return false; } } } });
  const tool = plugin.contributions.tools?.find(candidate => candidate.name === "cron_create")!;
  const authority = { capabilities: ["scheduler.write"], visibility: { kind: "restricted" as const, principalIds: ["member"], labels: [], resources: [] }, instructionAuthority: "scoped" as const };
  const result = await tool.execute({ name: "job", schedule: "0 9 * * *", prompt: "work" }, { execution: { origin: { kind: "interactive", transport: "discord", conversationId: "c" }, actor: { id: "member", kind: "human", roles: ["member"] }, authority }, operationId: "op", idempotencyKey: "key", signal: new AbortController().signal });
  assert.equal(result.ok, true); assert.deepEqual(created, [{ input: { name: "job", enabled: true, schedule: { kind: "cron", expression: "0 9 * * *" }, timezone: "Europe/London", jobRef: "agent.prompt", input: { prompt: "work" }, creatorPrincipalId: "member", creatorRoles: ["member"], authority, misfirePolicy: "coalesce", maxAttempts: 3, retryBackoffMs: 15000 }, key: "key" }]);
  const list = plugin.contributions.tools?.find(candidate => candidate.name === "schedule_list")!;
  const listed = await list.execute({}, { execution: { origin: { kind: "interactive", transport: "discord", conversationId: "c" }, actor: { id: "member", kind: "human", roles: ["member"] }, authority }, operationId: "op-list", signal: new AbortController().signal });
  assert.equal(listed.ok, true); assert.equal(listed.effectStatus, "not_applicable");
});
