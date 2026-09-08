import type { Operation } from "../operation/entities.js";
import type { OperationResult } from "../operation/result.js";
import type { ExecutionStore, RunCheckpoint } from "../ports/execution-store.js";
import type { ModelCallRecord } from "./records.js";
import type { Run, Step } from "./entities.js";

export type RecoveryDisposition = "resume" | "manual_review";

export interface RecoveryCandidate {
  readonly runId: string;
  readonly disposition: RecoveryDisposition;
  readonly interruptedOperationIds: readonly string[];
}

export interface StartupRecoveryOptions {
  readonly now?: () => string;
}

export interface RecoveryClaim {
  readonly run: Run;
  readonly checkpoint: RunCheckpoint;
  readonly steps: readonly Step[];
  readonly operations: readonly Operation[];
  readonly modelCalls: readonly ModelCallRecord[];
}

export class RunNotRecoverableError extends Error {
  constructor(readonly runId: string, message: string) {
    super(`run ${runId} is not recoverable: ${message}`);
    this.name = "RunNotRecoverableError";
  }
}

/**
 * Classifies work left by a dead singleton process before new work is accepted.
 * This does not resume model execution; it only makes external-effect evidence safe.
 */
export class StartupRecovery {
  private readonly now: () => string;

  constructor(private readonly store: ExecutionStore, options: StartupRecoveryOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async prepare(): Promise<readonly RecoveryCandidate[]> {
    const candidates: RecoveryCandidate[] = [];
    for (const listed of await this.store.listRecoverableRuns()) {
      const run = await this.store.getRun(listed.id);
      if (!run) continue;
      const operations = await this.store.listOperations(run.id);
      const interrupted = operations.filter(operation => operation.state === "executing");
      for (const operation of interrupted) await this.recordInterruptedOutcome(operation);

      const refreshed = await this.store.listOperations(run.id);
      const unsafe = refreshed.find(operation =>
        operation.sideEffect === "non_idempotent" && operation.state === "outcome_unknown");
      if (unsafe) {
        await this.waitForManualReview(run, unsafe);
        candidates.push({
          runId: run.id,
          disposition: "manual_review",
          interruptedOperationIds: interrupted.map(operation => operation.id),
        });
        continue;
      }

      if (run.state === "waiting" && run.resumeEligibility === "manual_review") {
        candidates.push({ runId: run.id, disposition: "manual_review", interruptedOperationIds: [] });
        continue;
      }
      if (run.state === "running") await this.waitForResume(run);
      candidates.push({
        runId: run.id,
        disposition: "resume",
        interruptedOperationIds: interrupted.map(operation => operation.id),
      });
    }
    return candidates;
  }

  /** CAS-claims one prepared Run so only one resumer can continue it. */
  async claim(runId: string): Promise<RecoveryClaim> {
    const run = await this.store.getRun(runId);
    if (!run) throw new RunNotRecoverableError(runId, "not found");
    if (run.state !== "waiting" || run.resumeEligibility !== "eligible") {
      throw new RunNotRecoverableError(runId, `state=${run.state}, eligibility=${run.resumeEligibility}`);
    }
    const checkpoint = await this.store.getCheckpoint(runId);
    if (!checkpoint) throw new RunNotRecoverableError(runId, "checkpoint is missing");
    await this.store.updateExecutionProgress({
      runId,
      expectedRunRevision: run.revision,
      expectedRunState: "waiting",
      runState: "running",
      resumeEligibility: "eligible",
      runUpdatedAt: this.now(),
    });
    const claimed = await this.store.getRun(runId);
    if (!claimed) throw new RunNotRecoverableError(runId, "disappeared after claim");
    return {
      run: claimed,
      checkpoint,
      steps: await this.store.listSteps(runId),
      operations: await this.store.listOperations(runId),
      modelCalls: await this.store.listModelCalls(runId),
    };
  }

  private async waitForResume(run: Run): Promise<void> {
    const occurredAt = this.now();
    await this.store.updateExecutionProgress({
      runId: run.id,
      expectedRunRevision: run.revision,
      expectedRunState: "running",
      runState: "waiting",
      waitingReason: "process_interrupted",
      interruption: { kind: "process_exit", occurredAt },
      resumeEligibility: "eligible",
      runUpdatedAt: occurredAt,
    });
  }

  private async recordInterruptedOutcome(operation: Operation): Promise<void> {
    const mutating = operation.sideEffect !== "none";
    const result: OperationResult = {
      operationId: operation.id,
      outcome: mutating ? "outcome_unknown" : "failed",
      effectStatus: mutating ? "unknown" : "not_applicable",
      error: {
        code: "process_interrupted",
        message: "the process exited while the operation was executing",
        retryable: operation.sideEffect !== "non_idempotent",
      },
      completedAt: this.now(),
    };
    await this.store.recordOperationOutcome(operation.id, result, result.completedAt);
  }

  private async waitForManualReview(run: Run, operation: Operation): Promise<void> {
    if (run.state === "waiting" && run.resumeEligibility === "manual_review") return;
    const step = await this.store.getStep(operation.stepId);
    const occurredAt = this.now();
    await this.store.updateExecutionProgress({
      runId: run.id,
      expectedRunRevision: run.revision,
      expectedRunState: run.state,
      runState: "waiting",
      waitingReason: "operation_outcome_unknown",
      interruption: { kind: "process_exit", occurredAt, detail: `operation ${operation.id} outcome is unknown` },
      resumeEligibility: "manual_review",
      runUpdatedAt: occurredAt,
      ...(step?.state === "running" ? {
        step: {
          id: step.id,
          expectedRevision: step.revision,
          expectedState: "running" as const,
          state: "failed" as const,
          updatedAt: occurredAt,
        },
      } : {}),
    });
  }
}
