import { ApprovalService, type ApprovalResolution } from "@umiro/core";
import type { ExecutionContext } from "@umiro/core/identity";
import type { JsonObject, JsonValue } from "@umiro/core/ports";
import type { ExecutionStore } from "@umiro/core/ports";
import type { Run, Step } from "@umiro/core/run";
import { ToolRuntime, type ToolRegistry } from "@umiro/core/tool";

interface ButtonCheckpoint extends JsonObject {
  readonly kind: "button_action";
  readonly toolName: string;
  readonly input: JsonObject;
}

function buttonCheckpoint(value: unknown): value is ButtonCheckpoint {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.kind === "button_action" && typeof record.toolName === "string" && record.input !== null && typeof record.input === "object" && !Array.isArray(record.input);
}

export class ButtonActionCoordinator {
  private readonly approvals: ApprovalService;
  private readonly runtime: ToolRuntime;

  constructor(private readonly store: ExecutionStore, tools: ToolRegistry, private readonly now = () => new Date().toISOString()) {
    this.approvals = new ApprovalService(store, now);
    this.runtime = new ToolRuntime(tools, store);
  }

  async handles(approvalId: string): Promise<boolean> {
    const approval = await this.store.getApproval(approvalId);
    if (!approval) return false;
    const operation = await this.store.getOperation(approval.operationId);
    const step = operation ? await this.store.getStep(operation.stepId) : undefined;
    const checkpoint = step ? await this.store.getCheckpoint(step.runId) : undefined;
    return buttonCheckpoint(checkpoint?.data);
  }

  async startAndExecute(input: { readonly toolName: string; readonly toolInput: JsonObject; readonly context: ExecutionContext; readonly idempotencyKey: string; readonly signal?: AbortSignal }): Promise<{ readonly runId: string; readonly status: string; readonly approvalId?: string; readonly output?: JsonValue }> {
    const createdAt = this.now(); const runId = crypto.randomUUID(); const stepId = crypto.randomUUID();
    const run: Run = { id: runId, revision: 0, state: "queued", context: input.context, resumeEligibility: "eligible", createdAt, updatedAt: createdAt };
    const step: Step = { id: stepId, runId, revision: 0, sequence: 0, kind: "operation", state: "pending", createdAt, updatedAt: createdAt };
    await this.store.createRunWithStep(run, step);
    await this.store.updateExecutionProgress({ runId, expectedRunRevision: 0, expectedRunState: "queued", runState: "running", resumeEligibility: "eligible", runUpdatedAt: createdAt, step: { id: stepId, expectedRevision: 0, expectedState: "pending", state: "running", updatedAt: createdAt } });
    const result = await this.runtime.execute({ toolName: input.toolName, input: input.toolInput, stepId, runId, context: input.context, idempotencyKey: input.idempotencyKey, ...(input.signal ? { signal: input.signal } : {}) });
    const terminal = result.status === "succeeded" ? "succeeded" : result.status === "approval_required" ? "waiting" : "failed";
    const updatedAt = this.now();
    await this.store.updateExecutionProgress({ runId, expectedRunRevision: 1, expectedRunState: "running", runState: terminal, ...(terminal === "waiting" ? { waitingReason: "approval_required" } : {}), resumeEligibility: terminal === "waiting" ? "manual_review" : "not_applicable", runUpdatedAt: updatedAt, ...(terminal === "waiting" ? { checkpoint: { runId, version: 1, data: createButtonActionCheckpoint(input.toolName, input.toolInput), updatedAt } } : { step: { id: stepId, expectedRevision: 1, expectedState: "running", state: terminal === "succeeded" ? "succeeded" : "failed", updatedAt } }) });
    if (result.status !== "approval_required") return { runId, status: result.status, ...("output" in result && result.output !== undefined ? { output: result.output } : {}) };
    const completed = await this.resolveAndExecute(result.approvalId, "approve", input.context, input.signal);
    return { runId, status: completed.status, approvalId: result.approvalId, ...(completed.output !== undefined ? { output: completed.output } : {}) };
  }

  async resolveAndExecute(approvalId: string, resolution: ApprovalResolution, context: ExecutionContext, signal?: AbortSignal): Promise<{ readonly approvalState: string; readonly runId: string; readonly status: string; readonly output?: JsonValue }> {
    const approval = await this.approvals.resolve(approvalId, resolution, context);
    const operation = await this.store.getOperation(approval.operationId);
    if (!operation) throw new Error(`approval ${approvalId} references a missing operation`);
    const step = await this.store.getStep(operation.stepId);
    if (!step) throw new Error(`approval ${approvalId} references a missing Step`);
    const run = await this.store.getRun(step.runId);
    if (!run) throw new Error(`approval ${approvalId} references a missing Run`);
    const checkpoint = await this.store.getCheckpoint(run.id);
    if (!buttonCheckpoint(checkpoint?.data)) throw new Error(`approval ${approvalId} is not a button action`);
    if (run.state !== "waiting") return { approvalState: approval.state, runId: run.id, status: run.state };
    const startedAt = this.now();
    await this.store.updateExecutionProgress({ runId: run.id, expectedRunRevision: run.revision, expectedRunState: "waiting", runState: "running", resumeEligibility: "eligible", runUpdatedAt: startedAt });
    const result = await this.runtime.resume(operation.id, { toolName: checkpoint.data.toolName, input: checkpoint.data.input, stepId: step.id, runId: run.id, context: run.context, ...(signal ? { signal } : {}) });
    const terminal = result.status === "succeeded" ? "succeeded" : result.status === "cancelled" ? "cancelled" : result.status === "outcome_unknown" ? "waiting" : "failed";
    const finishedAt = this.now();
    await this.store.updateExecutionProgress({
      runId: run.id,
      expectedRunRevision: run.revision + 1,
      expectedRunState: "running",
      runState: terminal,
      ...(terminal === "waiting" ? { waitingReason: "operation_outcome_unknown" } : {}),
      resumeEligibility: terminal === "waiting" ? "manual_review" : "not_applicable",
      runUpdatedAt: finishedAt,
      ...(terminal === "waiting" ? {} : { step: { id: step.id, expectedRevision: step.revision, expectedState: step.state, state: terminal === "succeeded" ? "succeeded" : terminal === "cancelled" ? "cancelled" : "failed", updatedAt: finishedAt }, clearCheckpoint: true }),
    });
    return { approvalState: approval.state, runId: run.id, status: terminal, ...("output" in result && result.output !== undefined ? { output: result.output } : {}) };
  }
}

export function createButtonActionCheckpoint(toolName: string, input: JsonObject): ButtonCheckpoint {
  return { kind: "button_action", toolName, input };
}
