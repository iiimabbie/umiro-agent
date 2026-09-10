import type { AuditEvent, AuthorizationDecisionRecord } from "../audit/records.js";
import type { ApprovalRequest } from "../approval/entities.js";
import type { ApprovalStore } from "../approval/store.js";
import type { Operation } from "../operation/entities.js";
import type { OperationResult } from "../operation/result.js";
import type { Run, RunState, Step, StepState } from "../run/entities.js";
import type { DeliveryIntent, ModelCallRecord, RunOutput } from "../run/records.js";
import type { JsonValue } from "./json.js";
import type { ModelContent } from "../model/contract.js";
import type { Authority } from "../authorization/authority.js";
import type { ExecutionContext } from "../identity/execution-context.js";
import type { PrincipalRole } from "../identity/principal.js";

export interface PendingSteeredInput {
  readonly id: string;
  readonly runId: string;
  readonly turnId: string;
  readonly content: ModelContent;
  readonly authority: Authority;
  readonly actorRoles: readonly PrincipalRole[];
  readonly createdAt: string;
}

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
  /** Replaces the durable Run context in the same transaction as progress. */
  readonly runContext?: ExecutionContext;
  readonly step?: {
    readonly id: string;
    readonly expectedRevision: number;
    readonly expectedState: StepState;
    readonly state: StepState;
    readonly updatedAt: string;
  };
  readonly checkpoint?: RunCheckpoint;
  readonly clearCheckpoint?: boolean;
  /** Pending steered inputs become consumed in the same transaction as the
   * checkpoint that first contains them. */
  readonly consumedSteeredInputIds?: readonly string[];
}

export interface CompleteRunWithOutput {
  readonly output: RunOutput;
  readonly delivery: DeliveryIntent;
  readonly expectedRunRevision: number;
  readonly runUpdatedAt: string;
}

export class ExecutionStoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionStoreConflictError";
  }
}

export interface ExecutionStore extends ApprovalStore {
  createRunWithStep(run: Run, firstStep: Step): Promise<void>;
  appendStep(step: Step): Promise<void>;
  recordModelCall(call: ModelCallRecord): Promise<void>;
  completeRunWithOutput(completion: CompleteRunWithOutput): Promise<void>;
  recordOperationAuthorization(operation: Operation, decision: AuthorizationDecisionRecord, approval?: ApprovalRequest): Promise<void>;
  markOperationExecuting(operationId: string, updatedAt: string): Promise<void>;
  recordOperationOutcome(operationId: string, result: OperationResult, updatedAt: string): Promise<void>;
  updateExecutionProgress(update: ExecutionProgressUpdate): Promise<void>;

  getRun(runId: string): Promise<Run | undefined>;
  /** Bounded newest-first query for operations and local control surfaces. */
  listRuns(limit?: number): Promise<readonly Run[]>;
  /** Used by the singleton daemon's startup sweep before it accepts new work. */
  listRecoverableRuns(): Promise<readonly Run[]>;
  getStep(stepId: string): Promise<Step | undefined>;
  listSteps(runId: string): Promise<readonly Step[]>;
  getOperation(operationId: string): Promise<Operation | undefined>;
  listOperations(runId: string): Promise<readonly Operation[]>;
  getOperationByIdempotencyKey(kind: string, idempotencyKey: string): Promise<Operation | undefined>;
  getAuthorizationDecision(decisionId: string): Promise<AuthorizationDecisionRecord | undefined>;
  getOperationResult(operationId: string): Promise<OperationResult | undefined>;
  getCheckpoint(runId: string): Promise<RunCheckpoint | undefined>;
  listModelCalls(runId: string): Promise<readonly ModelCallRecord[]>;
  getRunOutput(runId: string): Promise<RunOutput | undefined>;
  getDeliveryIntent(deliveryId: string): Promise<DeliveryIntent | undefined>;
  listPendingDeliveries(now?: string): Promise<readonly DeliveryIntent[]>;
  markDeliveryDelivered(deliveryId: string, deliveredAt: string, evidence?: import("./json.js").JsonObject): Promise<void>;
  markDeliveryFailed(deliveryId: string, error: string, nextAttemptAt: string, occurredAt: string): Promise<void>;
  listAuditEvents(runId: string): Promise<readonly AuditEvent[]>;
  listPendingSteeredInputs(runId: string): Promise<readonly PendingSteeredInput[]>;
  close(): void;
}
