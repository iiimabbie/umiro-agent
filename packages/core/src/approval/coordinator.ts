import type { ExecutionContext } from "../identity/execution-context.js";
import type { ExecutionStore } from "../ports/execution-store.js";
import type { HeadlessRunEngine, HeadlessRunResult } from "../run/engine.js";
import { StartupRecovery } from "../run/recovery.js";
import type { Run } from "../run/entities.js";
import type { ApprovalRequest, ApprovalResolution } from "./entities.js";
import { ApprovalService } from "./service.js";

export type ApprovalResumeResult =
  | { readonly status: "resumed"; readonly approval: ApprovalRequest; readonly runId: string; readonly result: HeadlessRunResult }
  | { readonly status: "existing"; readonly approval: ApprovalRequest; readonly runId: string; readonly runState: Run["state"] };

export class ApprovalRunCoordinator {
  private readonly approvals: ApprovalService;
  private readonly recovery: StartupRecovery;

  constructor(private readonly store: ExecutionStore, private readonly engine: HeadlessRunEngine, now = () => new Date().toISOString()) {
    this.approvals = new ApprovalService(store, now);
    this.recovery = new StartupRecovery(store, { now });
  }

  async resolveAndResume(id: string, resolution: ApprovalResolution, context: ExecutionContext, signal?: AbortSignal): Promise<ApprovalResumeResult> {
    const approval = await this.approvals.resolve(id, resolution, context);
    const operation = await this.store.getOperation(approval.operationId);
    if (!operation) throw new Error(`approval ${id} references a missing operation`);
    const step = await this.store.getStep(operation.stepId);
    if (!step) throw new Error(`approval ${id} references a missing Step`);
    const run = await this.store.getRun(step.runId);
    if (!run) throw new Error(`approval ${id} references a missing Run`);
    if (run.state !== "waiting" || run.resumeEligibility !== "eligible") return { status: "existing", approval, runId: run.id, runState: run.state };
    const claim = await this.recovery.claim(run.id);
    return { status: "resumed", approval, runId: run.id, result: await this.engine.resume(claim, signal ? { signal } : {}) };
  }
}
