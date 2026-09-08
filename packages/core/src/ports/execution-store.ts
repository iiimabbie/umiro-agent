import type { AuditEvent, AuthorizationDecisionRecord } from "../audit/records.js";
import type { Operation } from "../operation/entities.js";
import type { OperationResult } from "../operation/result.js";
import type { Run, RunState, Step, StepState } from "../run/entities.js";
import type { ModelCallRecord, RunOutput } from "../run/records.js";
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

export interface CompleteRunWithOutput {
  readonly output: RunOutput;
  readonly expectedRunRevision: number;
  readonly runUpdatedAt: string;
}

export class ExecutionStoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionStoreConflictError";
  }
}

export interface ExecutionStore {
  createRunWithStep(run: Run, firstStep: Step): Promise<void>;
  appendStep(step: Step): Promise<void>;
  recordModelCall(call: ModelCallRecord): Promise<void>;
  completeRunWithOutput(completion: CompleteRunWithOutput): Promise<void>;
  recordOperationAuthorization(operation: Operation, decision: AuthorizationDecisionRecord): Promise<void>;
  markOperationExecuting(operationId: string, updatedAt: string): Promise<void>;
  recordOperationOutcome(operationId: string, result: OperationResult, updatedAt: string): Promise<void>;
  updateExecutionProgress(update: ExecutionProgressUpdate): Promise<void>;

  getRun(runId: string): Promise<Run | undefined>;
  /** Used by the singleton daemon's startup sweep before it accepts new work. */
  listRecoverableRuns(): Promise<readonly Run[]>;
  getStep(stepId: string): Promise<Step | undefined>;
  getOperation(operationId: string): Promise<Operation | undefined>;
  getOperationByIdempotencyKey(kind: string, idempotencyKey: string): Promise<Operation | undefined>;
  getAuthorizationDecision(decisionId: string): Promise<AuthorizationDecisionRecord | undefined>;
  getOperationResult(operationId: string): Promise<OperationResult | undefined>;
  getCheckpoint(runId: string): Promise<RunCheckpoint | undefined>;
  listModelCalls(runId: string): Promise<readonly ModelCallRecord[]>;
  getRunOutput(runId: string): Promise<RunOutput | undefined>;
  listAuditEvents(runId: string): Promise<readonly AuditEvent[]>;
  close(): void;
}
