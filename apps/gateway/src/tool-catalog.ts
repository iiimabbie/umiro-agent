import type { JsonValue, ModelCapability, ToolDefinition, ToolExecutionContext, ToolRegistry } from "@umiro/core";

export interface CatalogSearchEntry {
  readonly name: string;
  readonly description: string;
}

export function createToolCatalogDefinition(
  tools: ToolRegistry,
  modelCapabilities: (context: ToolExecutionContext) => readonly ModelCapability[],
): ToolDefinition {
  return {
    name: "tool_catalog",
    description: "Search and inspect registered tools, then call an available tool by name. Catalog results do not grant permission; each target call is checked independently.",
    inputSchema: { type: "object", additionalProperties: false, required: ["action"], properties: {
      action: { type: "string", enum: ["list", "search", "describe", "call"] },
      query: { type: "string", minLength: 1, maxLength: 200 },
      tool_name: { type: "string", minLength: 1, maxLength: 128 },
      arguments: { type: "object", additionalProperties: true },
    }, allOf: [
      { if: { required: ["action"], properties: { action: { const: "search" } } }, then: { required: ["query"], properties: { query: {} } } },
      { if: { required: ["action"], properties: { action: { const: "describe" } } }, then: { required: ["tool_name"], properties: { tool_name: {} } } },
      { if: { required: ["action"], properties: { action: { const: "call" } } }, then: { required: ["tool_name", "arguments"], properties: { tool_name: {}, arguments: {} } } },
    ] },
    policy: { capability: "tool.catalog", tier: "common", interactionRequirement: "not_required", sideEffect: "none" },
    async execute(input, context) {
      const capabilities = new Set(context.execution.authority.capabilities);
      const supportedModels = new Set(modelCapabilities(context));
      const current = tools.list().filter(tool => tool.name !== "tool_catalog");
      const available = (tool: typeof current[number]) => capabilities.has(tool.policy.capability)
        && (!tool.policy.capability.startsWith("model.") || supportedModels.has(tool.policy.capability.slice("model.".length) as ModelCapability));
      const summary = (tool: typeof current[number]) => ({ name: tool.name, description: tool.description.slice(0, 1_000), available: available(tool) });
      if (input.action === "list") return { ok: true, effectStatus: "not_applicable", output: current.slice(0, 100).map(summary) };
      if (input.action === "search") return { ok: true, effectStatus: "not_applicable", output: searchToolCatalog(current, String(input.query)).slice(0, 20).map(summary) };
      if (input.action === "describe") {
        const tool = tools.get(String(input.tool_name));
        if (!tool || tool.name === "tool_catalog") return { ok: false, effectStatus: "not_applicable", error: { code: "tool_not_found", message: "unknown tool", retryable: false } };
        if (tool.description.length > 4_000 || JSON.stringify(tool.inputSchema).length > 8_000) return { ok: false, effectStatus: "not_applicable", error: { code: "tool_description_too_large", message: "tool description exceeds the catalog output limit", retryable: false } };
        return { ok: true, effectStatus: "not_applicable", output: { name: tool.name, description: tool.description, inputSchema: structuredClone(tool.inputSchema) as JsonValue, available: available(tool) } };
      }
      return { ok: false, effectStatus: "not_applicable", error: { code: "catalog_call_routing_required", message: "catalog calls are dispatched by the Run engine", retryable: false } };
    },
  };
}

export function searchToolCatalog<T extends CatalogSearchEntry>(entries: readonly T[], query: string): T[] {
  const normalized = query.trim().toLocaleLowerCase();
  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  return entries
    .filter(entry => {
      const text = `${entry.name} ${entry.description}`.toLocaleLowerCase();
      return tokens.every(token => text.includes(token));
    })
    .sort((left, right) => {
      const rank = (entry: CatalogSearchEntry): number => {
        const name = entry.name.toLocaleLowerCase();
        if (name === normalized) return 0;
        if (name.startsWith(normalized)) return 1;
        return -tokens.filter(token => name.includes(token)).length;
      };
      return rank(left) - rank(right) || left.name.localeCompare(right.name);
    });
}
