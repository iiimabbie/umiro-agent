import assert from "node:assert/strict";
import test from "node:test";
import { capabilities, ToolRegistry, type ExecutionContext } from "@umiro/core";
import { SQLiteExecutionStore } from "@umiro/storage-sqlite";
import { ButtonActionCoordinator } from "../src/button-action-coordinator.js";

const context: ExecutionContext = { actor: { id: "owner", kind: "human", roles: ["owner"] }, authority: { capabilities: capabilities("test.button"), visibility: { kind: "all" }, instructionAuthority: "none" }, origin: { kind: "interactive", transport: "discord", conversationId: "channel" } };

test("a function button executes its tool directly", async () => {
  const store = new SQLiteExecutionStore(":memory:"); const tools = new ToolRegistry(); let executions = 0;
  tools.register({ name: "test.button", description: "button action", inputSchema: { type: "object", additionalProperties: false, required: ["value"], properties: { value: { type: "string" } } }, policy: { capability: "test.button", tier: "privileged", interactionRequirement: "interactive_required", sideEffect: "idempotent" }, async execute(input) { executions += 1; return { ok: true, output: input, effectStatus: "confirmed" }; } });
  try { const result = await new ButtonActionCoordinator(store, tools).startAndExecute({ toolName: "test.button", toolInput: { value: "one" }, context, idempotencyKey: "button:set:go" }); assert.equal(result.status, "succeeded"); assert.deepEqual(result.output, { value: "one" }); assert.equal(executions, 1); assert.equal((await store.getRun(result.runId))?.state, "succeeded"); } finally { store.close(); }
});

test("a button tool without capability is denied before execution", async () => {
  const store = new SQLiteExecutionStore(":memory:"); const tools = new ToolRegistry();
  tools.register({ name: "test.button", description: "button action", inputSchema: { type: "object", additionalProperties: false }, policy: { capability: "test.button", tier: "privileged", interactionRequirement: "interactive_required", sideEffect: "idempotent" }, async execute() { throw new Error("must not execute"); } });
  try { const result = await new ButtonActionCoordinator(store, tools).startAndExecute({ toolName: "test.button", toolInput: {}, context: { ...context, authority: { ...context.authority, capabilities: [] } }, idempotencyKey: "button:set:denied" }); assert.equal(result.status, "denied"); } finally { store.close(); }
});
