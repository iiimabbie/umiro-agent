import type { JsonObject } from "@umiro/core/ports";
import type { PluginInstance, PluginSetupContext } from "@umiro/core/plugin";
import type { TaskPackage } from "@umiro/core/delegation";
import type { ToolDefinition, ToolExecutionResult } from "@umiro/core/tool";

const ok = (output: unknown): ToolExecutionResult => ({ ok: true, output: output as never, effectStatus: "confirmed" });
const fail = (error: unknown): ToolExecutionResult => ({ ok: false, effectStatus: "not_applicable", error: { code: "subagent_error", message: error instanceof Error ? error.message : String(error), retryable: false } });

export function createPlugin(setup: PluginSetupContext): PluginInstance {
  const childRuns = setup.services?.childRuns; if (!childRuns) throw new Error("subagent ChildRun service is unavailable");
  const replies = setup.services?.replies; if (!replies) throw new Error("subagent intermediate reply service is unavailable");
  const parentRunId = (context: Parameters<ToolDefinition["execute"]>[1]) => context.runId ?? (context.execution.origin.kind === "delegation" ? context.execution.origin.parentRunId : undefined);
  const delegate: ToolDefinition = { name: "subagent_delegate", description: "Delegate a bounded objective to a durable child agent run. The child receives only the explicit task package.", inputSchema: { type: "object", additionalProperties: false, required: ["objective", "prompt", "idempotencyKey", "model"], properties: { objective: { type: "string", minLength: 1 }, prompt: { type: "string", minLength: 1 }, idempotencyKey: { type: "string", minLength: 1 }, model: { type: "string", minLength: 1 }, constraints: { type: "array", items: { type: "string" } }, acceptanceCriteria: { type: "array", items: { type: "string" } }, outputContract: { type: "object" }, authorityScope: { type: "object" }, budgetCeiling: { type: "object" } } }, policy: { capability: "subagent.delegate", tier: "common", interactionRequirement: "not_required", sideEffect: "idempotent", concurrency: "parallel_safe" }, async execute(input, context) {
    try {
      const task: TaskPackage = { objective: String(input.objective), constraints: Array.isArray(input.constraints) ? input.constraints.filter((value): value is string => typeof value === "string") : [], acceptanceCriteria: Array.isArray(input.acceptanceCriteria) ? input.acceptanceCriteria.filter((value): value is string => typeof value === "string") : [], outputContract: input.outputContract && typeof input.outputContract === "object" && !Array.isArray(input.outputContract) ? input.outputContract as unknown as TaskPackage["outputContract"] : { kind: "text" } };
      const parent = parentRunId(context);
      if (!parent) throw new Error("subagent delegation requires a parent Run context");
      const result = await childRuns.start({ parentRunId: parent, idempotencyKey: String(input.idempotencyKey), task, authorityScope: input.authorityScope && typeof input.authorityScope === "object" && !Array.isArray(input.authorityScope) ? input.authorityScope as never : {}, model: String(input.model), prompt: String(input.prompt), ...(input.budgetCeiling && typeof input.budgetCeiling === "object" && !Array.isArray(input.budgetCeiling) ? { budgetCeiling: input.budgetCeiling as never } : {}), signal: context.signal });
      return ok(result);
    } catch (error) { return fail(error); }
  } };
  const wait: ToolDefinition = { name: "subagent_wait", description: "Wait until any selected Child Run reports back so the Parent can coordinate the others.", inputSchema: { type: "object", additionalProperties: false, properties: { childRunIds: { type: "array", maxItems: 2, items: { type: "string", minLength: 1 } } } }, policy: { capability: "subagent.delegate", tier: "common", interactionRequirement: "not_required", sideEffect: "none" }, async execute(input, context) {
    try { const parent = parentRunId(context); if (!parent) throw new Error("subagent wait requires a Parent Run context"); const ids = Array.isArray(input.childRunIds) ? input.childRunIds.filter((value): value is string => typeof value === "string") : []; return ok(await childRuns.waitForAny(parent, ids, context.signal)); }
    catch (error) { return fail(error); }
  } };
  const cancel: ToolDefinition = { name: "subagent_cancel", description: "Cancel one active Child Run created by this Parent Run.", inputSchema: { type: "object", additionalProperties: false, required: ["childRunId"], properties: { childRunId: { type: "string", minLength: 1 } } }, policy: { capability: "subagent.delegate", tier: "common", interactionRequirement: "not_required", sideEffect: "idempotent" }, async execute(input, context) {
    try {
      const parent = parentRunId(context);
      if (!parent) throw new Error("subagent cancellation requires a parent Run context");
      return ok(await childRuns.cancel(parent, String(input.childRunId)));
    } catch (error) { return fail(error); }
  } };
  const replyNow: ToolDefinition = { name: "reply_now", description: "Send one durable intermediate reply while this Parent Run continues coordinating Child Runs.", inputSchema: { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string", minLength: 1, maxLength: 2_000 } } }, policy: { capability: "subagent.delegate", tier: "common", interactionRequirement: "not_required", sideEffect: "idempotent" }, async execute(input, context) {
    try {
      const runId = parentRunId(context);
      if (!runId) throw new Error("intermediate reply requires a Parent Run context");
      return ok(await replies.send(runId, String(input.text), context.signal));
    } catch (error) { return fail(error); }
  } };
  return { contributions: { tools: [delegate, wait, cancel, replyNow] } };
}
