import type { ExecutionStore } from "../ports/execution-store.js";
import type { HeadlessRunEngine, HeadlessRunResult } from "./engine.js";
import { StartupRecovery, type RecoveryCandidate } from "./recovery.js";

export type RecoveryOutcome =
  | { readonly runId: string; readonly status: "manual_review" }
  | { readonly runId: string; readonly status: "resumed"; readonly result: HeadlessRunResult }
  | { readonly runId: string; readonly status: "failed"; readonly error: string };

export interface RecoveryCoordinatorOptions {
  readonly now?: () => string;
}

/** Runs once during singleton daemon startup, before accepting new work. */
export class HeadlessRecoveryCoordinator {
  private readonly recovery: StartupRecovery;
  private readonly now: () => string;

  constructor(
    private readonly store: ExecutionStore,
    private readonly engine: HeadlessRunEngine,
    options: RecoveryCoordinatorOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.recovery = new StartupRecovery(store, options);
  }

  async recoverAll(): Promise<readonly RecoveryOutcome[]> {
    const outcomes: RecoveryOutcome[] = [];
    for (const candidate of await this.recovery.prepare()) {
      if (candidate.disposition === "manual_review") {
        outcomes.push({ runId: candidate.runId, status: "manual_review" });
        continue;
      }
      outcomes.push(await this.resume(candidate));
    }
    return outcomes;
  }

  private async resume(candidate: RecoveryCandidate): Promise<RecoveryOutcome> {
    try {
      const claim = await this.recovery.claim(candidate.runId);
      const result = await this.engine.resume(claim);
      return { runId: candidate.runId, status: "resumed", result };
    } catch (caught) {
      await this.quarantine(candidate.runId, caught);
      return {
        runId: candidate.runId,
        status: "failed",
        error: caught instanceof Error ? caught.message : String(caught),
      };
    }
  }

  private async quarantine(runId: string, caught: unknown): Promise<void> {
    const run = await this.store.getRun(runId);
    if (!run || run.state !== "running") return;
    const occurredAt = this.now();
    try {
      await this.store.updateExecutionProgress({
        runId,
        expectedRunRevision: run.revision,
        expectedRunState: "running",
        runState: "waiting",
        waitingReason: "recovery_failed",
        interruption: {
          kind: "dependency_failure",
          occurredAt,
          detail: caught instanceof Error ? caught.message : String(caught),
        },
        resumeEligibility: "manual_review",
        runUpdatedAt: occurredAt,
      });
    } catch {
      // Another worker changed the Run after the failed claim; never overwrite it.
    }
  }
}
