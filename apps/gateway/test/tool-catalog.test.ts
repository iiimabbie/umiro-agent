import assert from "node:assert/strict";
import test from "node:test";
import { capabilities, ToolRegistry, type ExecutionContext, type ToolDefinition, type ToolExecutionContext } from "@umiro/core";
import { createToolCatalogDefinition, searchToolCatalog } from "../src/tool-catalog.js";

test("catalog search matches every query token and ranks tool names deterministically", () => {
  const entries = [
    { name: "calendar.events", description: "Create or inspect calendar events" },
    { name: "calendar.create", description: "Create a calendar entry" },
    { name: "notes.create", description: "Create a note" },
  ];
  assert.deepEqual(searchToolCatalog(entries, "calendar create"), [entries[1], entries[0]]);
  assert.deepEqual(searchToolCatalog(entries, "calendar missing"), []);
});

function executionContext(...granted: string[]): ToolExecutionContext {
  const execution: ExecutionContext = {
    actor: { id: "owner", kind: "human", roles: ["owner"] },
    origin: { kind: "event", pluginId: "catalog-test" },
    authority: { capabilities: capabilities(...granted), visibility: { kind: "all" }, instructionAuthority: "full" },
  };
  return { execution, operationId: "catalog-operation", signal: new AbortController().signal };
}

function target(name: string, description: string, capability: string): ToolDefinition {
  return {
    name,
    description,
    inputSchema: { type: "object", properties: { value: { type: "string" } }, additionalProperties: false },
    policy: { capability, tier: "common", interactionRequirement: "not_required", sideEffect: "none" },
    async execute() { return { ok: true, output: null, effectStatus: "not_applicable" }; },
  };
}

test("catalog list is bounded and reports Principal and model availability", async () => {
  const tools = new ToolRegistry();
  tools.register(target("test.allowed", "Allowed tool", "test.allowed"));
  tools.register(target("test.denied", "Denied tool", "test.denied"));
  tools.register(target("model.web", "Web search", "model.hosted_web_search"));
  for (let index = 0; index < 101; index += 1) tools.register(target(`test.entry-${index.toString().padStart(3, "0")}`, `Entry ${index}`, `test.entry-${index}`));
  const catalog = createToolCatalogDefinition(tools, () => []);
  tools.register(catalog);
  const result = await catalog.execute({ action: "list" }, executionContext("tool.catalog", "test.allowed", "model.hosted_web_search"));
  assert.equal(result.ok, true);
  if (!result.ok || !Array.isArray(result.output)) return;
  assert.equal(result.output.length, 100);
  const byName = new Map(result.output.map(entry => [String((entry as { name: string }).name), entry as { available: boolean }]));
  assert.equal(byName.get("test.allowed")?.available, true);
  assert.equal(byName.get("test.denied")?.available, false);
  assert.equal(byName.get("model.web")?.available, false);
  assert.equal(byName.has("tool_catalog"), false);
});

test("catalog describe returns the full schema when bounded and rejects oversized descriptions", async () => {
  const tools = new ToolRegistry();
  const schema = { type: "object", properties: { value: { type: "string", minLength: 2 } }, required: ["value"], additionalProperties: false };
  tools.register({ ...target("test.describe", "Inspectable tool", "test.describe"), inputSchema: schema });
  tools.register(target("test.large", "x".repeat(4_001), "test.large"));
  const catalog = createToolCatalogDefinition(tools, () => []);
  tools.register(catalog);
  const context = executionContext("tool.catalog");
  const described = await catalog.execute({ action: "describe", tool_name: "test.describe" }, context);
  assert.equal(described.ok, true);
  if (described.ok) assert.deepEqual(described.output, { name: "test.describe", description: "Inspectable tool", inputSchema: schema, available: false });
  const oversized = await catalog.execute({ action: "describe", tool_name: "test.large" }, context);
  assert.equal(oversized.ok, false);
  if (!oversized.ok) assert.equal(oversized.error.code, "tool_description_too_large");
});
