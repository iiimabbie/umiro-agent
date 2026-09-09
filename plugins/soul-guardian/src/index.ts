export * from "./service.js";
export * from "./types.js";
import type { JsonObject } from "@umiro/core/ports";
import type { PluginInstance, PluginSetupContext } from "@umiro/core/plugin";
import type { ToolDefinition, ToolExecutionResult } from "@umiro/core/tool";
import { SoulGuardianService } from "./service.js";
import type { SoulGuardianConfig } from "./types.js";

const CAP = {
  status: "soul_guardian.status", check: "soul_guardian.check", history: "soul_guardian.history",
  approve: "soul_guardian.approve", restore: "soul_guardian.restore",
} as const;
const ok = (output: unknown): ToolExecutionResult => ({ ok: true, output: output as never, effectStatus: "confirmed" });
const fail = (error: unknown): ToolExecutionResult => ({ ok: false, effectStatus: "not_applicable", error: { code: "soul_guardian_error", message: error instanceof Error ? error.message : String(error), retryable: false } });
const paths = (input: JsonObject): string[] => Array.isArray(input.paths) ? input.paths.filter((p): p is string => typeof p === "string") : [];

export function createPlugin(context: PluginSetupContext): PluginInstance {
  const config = context.config as unknown as SoulGuardianConfig;
  const service = new SoulGuardianService(config, context.state!);
  const tool = (name: string, description: string, capability: string, inputSchema: Record<string, unknown>, policy: Pick<ToolDefinition["policy"], "interactionRequirement" | "approvalRequirement" | "sideEffect">, run: (input: JsonObject) => Promise<ToolExecutionResult>): ToolDefinition => ({
    name, description, inputSchema, policy: { capability, tier: "privileged", ...policy }, execute: run,
  });
  return {
    contributions: { tools: [
      tool("soul_guardian_status", "Show monitored file integrity status.", CAP.status, { type: "object", additionalProperties: false, properties: {} }, { interactionRequirement: "not_required", sideEffect: "none" }, async () => { try { return ok(await service.status()); } catch (e) { return fail(e); } }),
      tool("soul_guardian_check", "Check monitored files and restore restore-mode drift.", CAP.check, { type: "object", additionalProperties: false, properties: { noRestore: { type: "boolean" } } }, { interactionRequirement: "not_required", sideEffect: "idempotent" }, async input => { try { return ok(await service.check(input.noRestore === true)); } catch (e) { return fail(e); } }),
      tool("soul_guardian_history", "List approval history for a monitored file.", CAP.history, { type: "object", required: ["path"], properties: { path: { type: "string" } } }, { interactionRequirement: "not_required", sideEffect: "none" }, async input => { try { return ok(await service.history(String(input.path))); } catch (e) { return fail(e); } }),
      tool("soul_guardian_approve", "Approve current contents as the new baseline.", CAP.approve, { type: "object", required: ["paths"], properties: { paths: { type: "array", items: { type: "string" } } } }, { interactionRequirement: "interactive_required", approvalRequirement: "required", sideEffect: "idempotent" }, async input => { try { return ok(await service.approve(paths(input))); } catch (e) { return fail(e); } }),
      tool("soul_guardian_restore", "Restore monitored files from their approved baseline.", CAP.restore, { type: "object", required: ["paths"], properties: { paths: { type: "array", items: { type: "string" } } } }, { interactionRequirement: "interactive_required", approvalRequirement: "required", sideEffect: "idempotent" }, async input => { try { return ok(await service.restore(paths(input))); } catch (e) { return fail(e); } }),
    ], jobs: [{ id: "soul-guardian.check", schedule: config.schedule, async run() { await service.check(); } }],
    commands: [{ name: "soul-guardian", description: "Show Soul Guardian integrity status", ownerOnly: true, async execute() { return { items: await service.status() } as never; } }],
    },
    start: () => service.start(),
  };
}
