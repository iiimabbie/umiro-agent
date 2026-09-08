import type { AuditEvent, AuthorizationDecisionRecord } from "../audit/records.js";
import type { Operation } from "../operation/entities.js";
import type { OperationResult } from "../operation/result.js";
import type { Run, RunState, Step, StepState } from "../run/entities.js";
import type { JsonValue } from "./json.js";

export interface RunCheckpoint {
  readonly runId: string;
  /** Starts at 1 and increases by exactly one for compare-and-swap updates. */
  readonly version: number;
  readonly data: JsonValue;
  readonly updatedAt: string;
}

export interface ExecutionProgressUpdate {
  readonly runId: string;
  readonly expectedRunRevision: number;
  readonly expectedRunState: RunState;
  readonly runState: RunState;
  readonly resumeEligibility: Run["resumeEligibility"];
  readonly waitingReason?: string;
  readonly interruption?: Run["interruption"];
  readonly runUpdatedAt: string;
  readonly step?: {
    readonly id: string;
    readonly expectedRevision: number;
    readonly expectedState: StepState;
    readonly state: StepState;
    readonly updatedAt: string;
  };
  readonly checkpoint?: RunCheckpoint;
  readonly clearCheckpoint?: boolean;
}

export class ExecutionStoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionStoreConflictError";
  }
}

export interface ExecutionStore {
  createRunWithStep(run: Run, firstStep: Step): Promise<void>;
  recordOperationAuthorization(operation: Operation, decision: AuthorizationDecisionRecord): Promise<void>;
  markOperationExecuting(operationId: string, updatedAt: string): Promise<void>;
  recordOperationOutcome(operationId: string, result: OperationResult, updatedAt: string): Promise<void>;
  updateExecutionProgress(update: ExecutionProgressUpdate): Promise<void>;

  getRun(runId: string): Promise<Run | undefined>;
  getStep(stepId: string): Promise<Step | undefined>;
  getOperation(operationId: string): Promise<Operation | undefined>;
  getAuthorizationDecision(decisionId: string): Promise<AuthorizationDecisionRecord | undefined>;
  getOperationResult(operationId: string): Promise<OperationResult | undefined>;
  getCheckpoint(runId: string): Promise<RunCheckpoint | undefined>;
  listAuditEvents(runId: string): Promise<readonly AuditEvent[]>;
  close(): void;
}
