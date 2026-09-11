import type { ExecutionContext } from "@umiro/core/identity";
import type { JsonObject, JsonValue } from "@umiro/core/ports";
import type { ExecutionStore } from "@umiro/core/ports";
import type { Run, Step } from "@umiro/core/run";
import { ToolRuntime, type ToolRegistry } from "@umiro/core/tool";

export class ButtonActionCoordinator {
  private readonly runtime: ToolRuntime;

  constructor(private readonly store: ExecutionStore, tools: ToolRegistry, private readonly now = () => new Date().toISOString()) {
    this.runtime = new ToolRuntime(tools, store);
  }

  async startAndExecute(input: { readonly toolName: string; readonly toolInput: JsonObject; readonly context: ExecutionContext; readonly idempotencyKey: string; readonly signal?: AbortSignal }): Promise<{ readonly runId: string; readonly status: string; readonly output?: JsonValue }> {
    const createdAt = this.now(); const runId = crypto.randomUUID(); const stepId = crypto.randomUUID();
    const run: Run = { id: runId, revision: 0, state: "queued", context: input.context, resumeEligibility: "eligible", createdAt, updatedAt: createdAt };
    const step: Step = { id: stepId, runId, revision: 0, sequence: 0, kind: "operation", state: "pending", createdAt, updatedAt: createdAt };
    await this.store.createRunWithStep(run, step);
    await this.store.updateExecutionProgress({ runId, expectedRunRevision: 0, expectedRunState: "queued", runState: "running", resumeEligibility: "eligible", runUpdatedAt: createdAt, step: { id: stepId, expectedRevision: 0, expectedState: "pending", state: "running", updatedAt: createdAt } });
    const result = await this.runtime.execute({ toolName: input.toolName, input: input.toolInput, stepId, runId, context: input.context, idempotencyKey: input.idempotencyKey, ...(input.signal ? { signal: input.signal } : {}) });
    const terminal = result.status === "succeeded" ? "succeeded" : result.status === "cancelled" ? "cancelled" : result.status === "outcome_unknown" ? "waiting" : "failed";
    const updatedAt = this.now();
    await this.store.updateExecutionProgress({ runId, expectedRunRevision: 1, expectedRunState: "running", runState: terminal, ...(terminal === "waiting" ? { waitingReason: "operation_outcome_unknown" } : {}), resumeEligibility: terminal === "waiting" ? "manual_review" : "not_applicable", runUpdatedAt: updatedAt, ...(terminal === "waiting" ? {} : { step: { id: stepId, expectedRevision: 1, expectedState: "running", state: terminal === "succeeded" ? "succeeded" : terminal === "cancelled" ? "cancelled" : "failed", updatedAt } }) });
    return { runId, status: result.status, ...("output" in result && result.output !== undefined ? { output: result.output } : {}) };
  }
}
