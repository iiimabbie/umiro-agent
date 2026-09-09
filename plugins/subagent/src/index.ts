import type { JsonObject } from "@umiro/core/ports";
import type { PluginInstance, PluginSetupContext } from "@umiro/core/plugin";
import type { TaskPackage } from "@umiro/core/delegation";
import type { ToolDefinition, ToolExecutionResult } from "@umiro/core/tool";

const ok = (output: unknown): ToolExecutionResult => ({ ok: true, output: output as never, effectStatus: "confirmed" });
const fail = (error: unknown): ToolExecutionResult => ({ ok: false, effectStatus: "not_applicable", error: { code: "subagent_error", message: error instanceof Error ? error.message : String(error), retryable: false } });

export function createPlugin(setup: PluginSetupContext): PluginInstance {
  const childRuns = setup.services?.childRuns; if (!childRuns) throw new Error("subagent ChildRun service is unavailable");
  const tool: ToolDefinition = { name: "subagent_delegate", description: "Delegate a bounded objective to a durable child agent run. The child receives only the explicit task package.", inputSchema: { type: "object", additionalProperties: false, required: ["objective", "prompt", "idempotencyKey", "model"], properties: { objective: { type: "string", minLength: 1 }, prompt: { type: "string", minLength: 1 }, idempotencyKey: { type: "string", minLength: 1 }, model: { type: "string", minLength: 1 }, contextRefs: { type: "array", items: { type: "object" } }, constraints: { type: "array", items: { type: "string" } }, acceptanceCriteria: { type: "array", items: { type: "string" } }, outputContract: { type: "object" }, authorityScope: { type: "object" }, budgetCeiling: { type: "object" }, agentProfileRef: { type: "string" } } }, policy: { capability: "subagent.delegate", tier: "common", interactionRequirement: "not_required", sideEffect: "idempotent" }, async execute(input, context) {
    try {
      const task: TaskPackage = { objective: String(input.objective), contextRefs: Array.isArray(input.contextRefs) ? input.contextRefs as TaskPackage["contextRefs"] : [], constraints: Array.isArray(input.constraints) ? input.constraints.filter((value): value is string => typeof value === "string") : [], acceptanceCriteria: Array.isArray(input.acceptanceCriteria) ? input.acceptanceCriteria.filter((value): value is string => typeof value === "string") : [], outputContract: input.outputContract && typeof input.outputContract === "object" && !Array.isArray(input.outputContract) ? input.outputContract as unknown as TaskPackage["outputContract"] : { kind: "text" } };
      const parentRunId = context.runId ?? (context.execution.origin.kind === "delegation" ? context.execution.origin.parentRunId : undefined);
      if (!parentRunId) throw new Error("subagent delegation requires a parent Run context");
      const result = await childRuns.execute({ parentRunId, idempotencyKey: String(input.idempotencyKey), task, authorityScope: input.authorityScope && typeof input.authorityScope === "object" && !Array.isArray(input.authorityScope) ? input.authorityScope as never : {}, model: String(input.model), prompt: String(input.prompt), ...(input.budgetCeiling && typeof input.budgetCeiling === "object" && !Array.isArray(input.budgetCeiling) ? { budgetCeiling: input.budgetCeiling as never } : {}), ...(typeof input.agentProfileRef === "string" ? { agentProfileRef: input.agentProfileRef } : {}), signal: context.signal });
      return ok(result);
    } catch (error) { return fail(error); }
  } };
  return { contributions: { tools: [tool] } };
}
