import type { JsonObject } from "@umiro/core/ports";
import type { PluginInstance, PluginSetupContext } from "@umiro/core/plugin";
import type { TaskPackage } from "@umiro/core/delegation";
import type { ToolDefinition, ToolExecutionResult } from "@umiro/core/tool";
import { intersectVisibility, type AuthorityScopeRequest } from "@umiro/core/authorization";
import type { BudgetCeiling, OutputContract } from "@umiro/core/delegation";

const ok = (output: unknown, sideEffect: ToolDefinition["policy"]["sideEffect"]): ToolExecutionResult => ({ ok: true, output: output as never, effectStatus: sideEffect === "none" ? "not_applicable" : "confirmed" });
const fail = (error: unknown): ToolExecutionResult => ({ ok: false, effectStatus: "not_applicable", error: { code: "subagent_error", message: error instanceof Error ? error.message : String(error), retryable: false } });
const instructionRank = { none: 0, scoped: 1, full: 2 } as const;
function narrowAuthority(left: AuthorityScopeRequest, right: AuthorityScopeRequest): AuthorityScopeRequest {
  const capabilities = left.capabilities && right.capabilities ? left.capabilities.filter(value => right.capabilities!.includes(value)) : left.capabilities ?? right.capabilities;
  const visibility = left.visibility && right.visibility ? intersectVisibility(left.visibility, right.visibility) : left.visibility ?? right.visibility;
  const instructionAuthority = left.instructionAuthority && right.instructionAuthority ? (instructionRank[left.instructionAuthority] <= instructionRank[right.instructionAuthority] ? left.instructionAuthority : right.instructionAuthority) : left.instructionAuthority ?? right.instructionAuthority;
  return { ...(capabilities ? { capabilities } : {}), ...(visibility ? { visibility } : {}), ...(instructionAuthority ? { instructionAuthority } : {}) };
}
function narrowBudget(left?: BudgetCeiling, right?: BudgetCeiling): BudgetCeiling | undefined {
  if (!left) return right; if (!right) return left;
  const result: Record<string, number> = {};
  for (const key of ["maxModelTurns", "maxToolCalls", "maxInputTokens", "maxOutputTokens", "maxDurationMs"] as const) { const values = [left[key], right[key]].filter((value): value is number => value !== undefined); if (values.length) result[key] = Math.min(...values); }
  return result as BudgetCeiling;
}
function compilePrompt(instructions: readonly string[], task: TaskPackage, detail?: string): string {
  return [instructions.join("\n").trim(), `Objective:\n${task.objective}`, task.constraints.length ? `Constraints:\n${task.constraints.map(item => `- ${item}`).join("\n")}` : "", task.acceptanceCriteria.length ? `Acceptance criteria:\n${task.acceptanceCriteria.map(item => `- ${item}`).join("\n")}` : "", `Output contract:\n${JSON.stringify(task.outputContract)}`, detail?.trim() ? `Additional detail:\n${detail.trim()}` : ""].filter(Boolean).join("\n\n");
}

export function createPlugin(setup: PluginSetupContext): PluginInstance {
  const childRuns = setup.services?.childRuns; if (!childRuns) throw new Error("subagent ChildRun service is unavailable");
  const profiles = setup.services?.subagentProfiles;
  const replies = setup.services?.replies; if (!replies) throw new Error("subagent intermediate reply service is unavailable");
  const parentRunId = (context: Parameters<ToolDefinition["execute"]>[1]) => context.runId ?? (context.execution.origin.kind === "delegation" ? context.execution.origin.parentRunId : undefined);
  const profileCatalog: ToolDefinition = { name: "subagent_profiles", description: "List the currently registered Subagent profiles and only the information needed to choose one. Call this when selecting an installed profile; for a direct delegation, use subagent_delegate with prompt and a complete model ID.", inputSchema: { type: "object", additionalProperties: false }, policy: { capability: "subagent.delegate", tier: "common", interactionRequirement: "not_required", sideEffect: "none" }, async execute() {
    const choices = (profiles?.list() ?? []).map(profile => ({
      id: profile.id,
      description: profile.description.slice(0, 1_000),
      ...(profile.model ? { modelProfile: profile.model } : { requiresModel: true }),
      ...(profile.requiredTools?.length ? { requiredTools: [...profile.requiredTools].slice(0, 32) } : {}),
    }));
    return ok(choices, "none");
  } };
  const delegate: ToolDefinition = { name: "subagent_delegate", description: "Delegate a bounded objective to a durable Child Run. For an installed Subagent role, first call subagent_profiles and provide its exact profile ID. For a direct delegation, provide a self-contained prompt and a complete actual model ID such as gpt-5.6-terra, gpt-5.6-luna, or gpt-5.6-sol.", inputSchema: { type: "object", additionalProperties: false, required: ["objective", "idempotencyKey"], properties: { objective: { type: "string", minLength: 1 }, profile: { type: "string", minLength: 1, description: "Registered Subagent role/profile ID for role-based delegation." }, prompt: { type: "string", minLength: 1, description: "Self-contained instructions for the Child Run; required when profile is omitted." }, idempotencyKey: { type: "string", minLength: 1 }, model: { type: "string", minLength: 1, description: "Complete actual model ID for the Child Run, for example gpt-5.6-terra, gpt-5.6-luna, or gpt-5.6-sol." }, constraints: { type: "array", items: { type: "string" } }, acceptanceCriteria: { type: "array", items: { type: "string" } }, outputContract: { type: "object" }, authorityScope: { type: "object" }, budgetCeiling: { type: "object" } } }, policy: { capability: "subagent.delegate", tier: "common", interactionRequirement: "not_required", sideEffect: "idempotent", concurrency: "parallel_safe" }, async execute(input, context) {
    try {
      const selected = typeof input.profile === "string" ? profiles?.get(input.profile) : undefined;
      if (typeof input.profile === "string" && !selected) throw new Error(`unknown subagent profile: ${input.profile}; available profiles: ${profiles?.list().map(profile => profile.id).join(", ") || "none"}`);
      if (!selected && (typeof input.prompt !== "string" || typeof input.model !== "string")) throw new Error("subagent delegation requires a profile, or both prompt and model");
      if (selected && !selected.model && typeof input.model !== "string") throw new Error(`subagent profile ${selected.id} does not fix a model; model is required`);
      if (selected?.model && typeof input.model === "string" && input.model !== selected.model) throw new Error(`subagent profile ${selected.id} fixes model profile ${selected.model}; model cannot be overridden`);
      const outputContract = input.outputContract && typeof input.outputContract === "object" && !Array.isArray(input.outputContract) ? input.outputContract as unknown as OutputContract : selected?.outputContract ?? { kind: "text" as const };
      const task: TaskPackage = { objective: String(input.objective), constraints: Array.isArray(input.constraints) ? input.constraints.filter((value): value is string => typeof value === "string") : [], acceptanceCriteria: Array.isArray(input.acceptanceCriteria) ? input.acceptanceCriteria.filter((value): value is string => typeof value === "string") : [], outputContract };
      const parent = parentRunId(context);
      if (!parent) throw new Error("subagent delegation requires a parent Run context");
      const requestedAuthority = input.authorityScope && typeof input.authorityScope === "object" && !Array.isArray(input.authorityScope) ? input.authorityScope as AuthorityScopeRequest : {};
      const requestedBudget = input.budgetCeiling && typeof input.budgetCeiling === "object" && !Array.isArray(input.budgetCeiling) ? input.budgetCeiling as BudgetCeiling : undefined;
      const budgetCeiling = narrowBudget(selected?.budgetCeiling, requestedBudget);
      const result = await childRuns.start({ parentRunId: parent, idempotencyKey: String(input.idempotencyKey), task, authorityScope: narrowAuthority(selected?.authorityScope ?? {}, requestedAuthority), model: selected?.model ?? String(input.model), prompt: selected ? compilePrompt(selected.instructions, task, typeof input.prompt === "string" ? input.prompt : undefined) : String(input.prompt), ...(budgetCeiling ? { budgetCeiling } : {}), signal: context.signal });
      return ok(result, "idempotent");
    } catch (error) { return fail(error); }
  } };
  const wait: ToolDefinition = { name: "subagent_wait", description: "Wait until any selected Child Run reports back so the Parent can coordinate the others.", inputSchema: { type: "object", additionalProperties: false, properties: { childRunIds: { type: "array", maxItems: 2, items: { type: "string", minLength: 1 } } } }, policy: { capability: "subagent.delegate", tier: "common", interactionRequirement: "not_required", sideEffect: "none" }, async execute(input, context) {
    try { const parent = parentRunId(context); if (!parent) throw new Error("subagent wait requires a Parent Run context"); const ids = Array.isArray(input.childRunIds) ? input.childRunIds.filter((value): value is string => typeof value === "string") : []; return ok(await childRuns.waitForAny(parent, ids, context.signal), "none"); }
    catch (error) { return fail(error); }
  } };
  const cancel: ToolDefinition = { name: "subagent_cancel", description: "Cancel one active Child Run created by this Parent Run.", inputSchema: { type: "object", additionalProperties: false, required: ["childRunId"], properties: { childRunId: { type: "string", minLength: 1 } } }, policy: { capability: "subagent.delegate", tier: "common", interactionRequirement: "not_required", sideEffect: "idempotent" }, async execute(input, context) {
    try {
      const parent = parentRunId(context);
      if (!parent) throw new Error("subagent cancellation requires a parent Run context");
      return ok(await childRuns.cancel(parent, String(input.childRunId)), "idempotent");
    } catch (error) { return fail(error); }
  } };
  const replyNow: ToolDefinition = { name: "reply_now", description: "Send one durable intermediate reply while this Parent Run continues coordinating Child Runs.", inputSchema: { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string", minLength: 1, maxLength: 2_000 } } }, policy: { capability: "subagent.delegate", tier: "common", interactionRequirement: "not_required", sideEffect: "idempotent" }, async execute(input, context) {
    try {
      const runId = parentRunId(context);
      if (!runId) throw new Error("intermediate reply requires a Parent Run context");
      return ok(await replies.send(runId, String(input.text), context.signal), "idempotent");
    } catch (error) { return fail(error); }
  } };
  return { contributions: { tools: [delegate, wait, cancel, replyNow, profileCatalog] } };
}
