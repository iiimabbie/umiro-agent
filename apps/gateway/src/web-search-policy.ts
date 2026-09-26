import type { ToolDefinition } from "@umiro/core/tool";

export const hostedWebSearchPolicy = {
  capability: "model.hosted_web_search",
  tier: "common",
  interactionRequirement: "not_required",
  sideEffect: "none",
  timeoutMs: 120_000,
} as const satisfies ToolDefinition["policy"];
