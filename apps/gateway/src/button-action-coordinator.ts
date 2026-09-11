import { ApprovalService, type ApprovalResolution } from "@umiro/core";
import type { ExecutionContext } from "@umiro/core/identity";
import type { JsonObject } from "@umiro/core/ports";
import type { ExecutionStore } from "@umiro/core/ports";
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

  async resolveAndExecute(approvalId: string, resolution: ApprovalResolution, context: ExecutionContext, signal?: AbortSignal): Promise<{ readonly approvalState: string; readonly runId: string; readonly status: string }> {
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
    return { approvalState: approval.state, runId: run.id, status: terminal };
  }
}

export function createButtonActionCheckpoint(toolName: string, input: JsonObject): ButtonCheckpoint {
  return { kind: "button_action", toolName, input };
}
