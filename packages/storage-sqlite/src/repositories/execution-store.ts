import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import {
  assertOperationInvariants,
  assertOperationResult,
  assertOperationTransition,
  assertRunTransition,
  assertStepTransition,
  ExecutionStoreConflictError,
  type AuditEvent,
  type AuthorizationDecisionRecord,
  type ExecutionContext,
  type ExecutionProgressUpdate,
  type ExecutionStore,
  type JsonValue,
  type Operation,
  type OperationResult,
  type Run,
  type RunCheckpoint,
  type RunState,
  type Step,
  type StepState,
} from "@umiro/core";
import { migrate } from "../migrations/index.js";

interface RunRow {
  id: string;
  revision: number;
  state: RunState;
  context_json: string;
  conversation_id: string | null;
  turn_id: string | null;
  parent_run_id: string | null;
  waiting_reason: string | null;
  interruption_json: string | null;
  resume_eligibility: Run["resumeEligibility"];
  created_at: string;
  updated_at: string;
}

interface StepRow {
  id: string;
  run_id: string;
  revision: number;
  sequence: number;
  kind: Step["kind"];
  state: StepState;
  created_at: string;
  updated_at: string;
}

interface OperationRow {
  id: string;
  step_id: string;
  kind: string;
  state: Operation["state"];
  capability: string;
  authorization_tier: Operation["authorizationTier"];
  side_effect: Operation["sideEffect"];
  idempotency_key: string | null;
  authorization_decision_id: string;
  created_at: string;
  updated_at: string;
}

interface DecisionRow {
  id: string;
  operation_id: string;
  allow: number;
  reason: AuthorizationDecisionRecord["reason"];
  policy_id: AuthorizationDecisionRecord["policyId"];
  principal_id: string;
  capability: string;
  tier: AuthorizationDecisionRecord["tier"];
  resource_json: string | null;
  decided_at: string;
}

interface ResultRow {
  operation_id: string;
  outcome: OperationResult["outcome"];
  effect_status: OperationResult["effectStatus"];
  output_json: string | null;
  error_json: string | null;
  completed_at: string;
}

interface CheckpointRow {
  run_id: string;
  version: number;
  data_json: string;
  updated_at: string;
}

interface AuditRow {
  sequence: number;
  kind: string;
  entity_type: AuditEvent["entityType"];
  entity_id: string;
  run_id: string;
  data_json: string;
  occurred_at: string;
}

function json(value: JsonValue | object): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("value is not JSON serializable");
  return serialized;
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function expectOne(changes: number, message: string): void {
  if (changes !== 1) throw new ExecutionStoreConflictError(message);
}

export class SQLiteExecutionStore implements ExecutionStore {
  private readonly database: Database.Database;

  constructor(filename: string) {
    if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
    this.database = new Database(filename);
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("busy_timeout = 5000");
    if (filename !== ":memory:") this.database.pragma("journal_mode = WAL");
    this.database.pragma("synchronous = FULL");
    migrate(this.database);
  }

  async createRunWithStep(run: Run, firstStep: Step): Promise<void> {
    if (firstStep.runId !== run.id) throw new TypeError("first step must belong to the new run");
    if (run.revision !== 0 || firstStep.revision !== 0) throw new TypeError("new runs and steps must begin at revision zero");
    if (firstStep.sequence !== 0) throw new TypeError("first step sequence must be zero");
    if (run.state !== "queued" || firstStep.state !== "pending") {
      throw new TypeError("new execution must begin with a queued run and pending step");
    }

    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO runs(
          id, revision, state, context_json, conversation_id, turn_id, parent_run_id,
          waiting_reason, interruption_json, resume_eligibility, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        run.id,
        run.revision,
        run.state,
        json(run.context),
        run.conversationId ?? null,
        run.turnId ?? null,
        run.parentRunId ?? null,
        run.waitingReason ?? null,
        run.interruption ? json(run.interruption) : null,
        run.resumeEligibility,
        run.createdAt,
        run.updatedAt,
      );
      this.database.prepare(`
        INSERT INTO steps(id, run_id, revision, sequence, kind, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(firstStep.id, firstStep.runId, firstStep.revision, firstStep.sequence, firstStep.kind, firstStep.state, firstStep.createdAt, firstStep.updatedAt);
      this.insertAudit("run.created", "run", run.id, run.id, { state: run.state }, run.createdAt);
      this.insertAudit("step.created", "step", firstStep.id, run.id, { kind: firstStep.kind, sequence: firstStep.sequence }, firstStep.createdAt);
    })();
  }

  async recordOperationAuthorization(operation: Operation, decision: AuthorizationDecisionRecord): Promise<void> {
    assertOperationInvariants(operation);
    if (operation.authorizationDecisionId !== decision.id) throw new TypeError("operation must reference its authorization decision");
    if (decision.operationId !== operation.id) throw new TypeError("authorization decision must reference its operation");
    if (decision.capability !== operation.capability || decision.tier !== operation.authorizationTier) {
      throw new TypeError("authorization decision does not match the operation policy request");
    }
    const expectedState = decision.allow ? "authorized" : "denied";
    if (operation.state !== expectedState) throw new TypeError(`authorization outcome requires operation state ${expectedState}`);

    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO authorization_decisions(
          id, operation_id, allow, reason, policy_id, principal_id,
          capability, tier, resource_json, decided_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        decision.id,
        decision.operationId,
        decision.allow ? 1 : 0,
        decision.reason,
        decision.policyId,
        decision.principalId,
        decision.capability,
        decision.tier,
        decision.resource ? json(decision.resource) : null,
        decision.decidedAt,
      );
      this.database.prepare(`
        INSERT INTO operations(
          id, step_id, kind, state, capability, authorization_tier, side_effect,
          idempotency_key, authorization_decision_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        operation.id,
        operation.stepId,
        operation.kind,
        operation.state,
        operation.capability,
        operation.authorizationTier,
        operation.sideEffect,
        operation.idempotencyKey ?? null,
        decision.id,
        operation.createdAt,
        operation.updatedAt,
      );
      const runId = this.runIdForOperation(operation.id);
      this.insertAudit(
        "operation.authorization_decided",
        "authorization",
        decision.id,
        runId,
        { operationId: operation.id, allow: decision.allow, reason: decision.reason },
        decision.decidedAt,
      );
    })();
  }

  async markOperationExecuting(operationId: string, updatedAt: string): Promise<void> {
    this.database.transaction(() => {
      const current = this.operationState(operationId);
      assertOperationTransition(current, "executing");
      const result = this.database.prepare("UPDATE operations SET state = 'executing', updated_at = ? WHERE id = ? AND state = ?")
        .run(updatedAt, operationId, current);
      expectOne(result.changes, `operation ${operationId} changed concurrently`);
      const runId = this.runIdForOperation(operationId);
      this.insertAudit("operation.executing", "operation", operationId, runId, { from: current, to: "executing" }, updatedAt);
    })();
  }

  async recordOperationOutcome(operationId: string, result: OperationResult, updatedAt: string): Promise<void> {
    if (result.operationId !== operationId) throw new TypeError("operation result references a different operation");
    assertOperationResult(result);
    this.database.transaction(() => {
      const current = this.operationState(operationId);
      assertOperationTransition(current, result.outcome);
      this.database.prepare(`
        INSERT INTO operation_results(operation_id, outcome, effect_status, output_json, error_json, completed_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        operationId,
        result.outcome,
        result.effectStatus,
        result.output === undefined ? null : json(result.output),
        result.error ? json(result.error) : null,
        result.completedAt,
      );
      const update = this.database.prepare("UPDATE operations SET state = ?, updated_at = ? WHERE id = ? AND state = ?")
        .run(result.outcome, updatedAt, operationId, current);
      expectOne(update.changes, `operation ${operationId} changed concurrently`);
      const runId = this.runIdForOperation(operationId);
      this.insertAudit(
        "operation.completed",
        "operation",
        operationId,
        runId,
        { outcome: result.outcome, effectStatus: result.effectStatus },
        result.completedAt,
      );
    })();
  }

  async updateExecutionProgress(update: ExecutionProgressUpdate): Promise<void> {
    if (update.checkpoint && update.clearCheckpoint) throw new TypeError("cannot save and clear a checkpoint together");
    this.database.transaction(() => {
      const currentRun = this.database.prepare("SELECT state, revision FROM runs WHERE id = ?").get(update.runId) as { state: RunState; revision: number } | undefined;
      if (!currentRun) throw new ExecutionStoreConflictError(`run ${update.runId} does not exist`);
      if (currentRun.state !== update.expectedRunState || currentRun.revision !== update.expectedRunRevision) {
        throw new ExecutionStoreConflictError(`run ${update.runId} changed concurrently`);
      }
      if (currentRun.state !== update.runState) assertRunTransition(currentRun.state, update.runState);

      const runUpdate = this.database.prepare(`
        UPDATE runs
        SET revision = revision + 1, state = ?, waiting_reason = ?, interruption_json = ?, resume_eligibility = ?, updated_at = ?
        WHERE id = ? AND state = ? AND revision = ?
      `).run(
        update.runState,
        update.waitingReason ?? null,
        update.interruption ? json(update.interruption) : null,
        update.resumeEligibility,
        update.runUpdatedAt,
        update.runId,
        update.expectedRunState,
        update.expectedRunRevision,
      );
      expectOne(runUpdate.changes, `run ${update.runId} changed concurrently`);

      if (update.step) {
        const currentStep = this.database.prepare("SELECT state, revision FROM steps WHERE id = ? AND run_id = ?")
          .get(update.step.id, update.runId) as { state: StepState; revision: number } | undefined;
        if (!currentStep || currentStep.state !== update.step.expectedState || currentStep.revision !== update.step.expectedRevision) {
          throw new ExecutionStoreConflictError(`step ${update.step.id} changed concurrently`);
        }
        if (currentStep.state !== update.step.state) assertStepTransition(currentStep.state, update.step.state);
        const stepUpdate = this.database.prepare("UPDATE steps SET revision = revision + 1, state = ?, updated_at = ? WHERE id = ? AND run_id = ? AND state = ? AND revision = ?")
          .run(update.step.state, update.step.updatedAt, update.step.id, update.runId, update.step.expectedState, update.step.expectedRevision);
        expectOne(stepUpdate.changes, `step ${update.step.id} changed concurrently`);
      }

      if (update.checkpoint) this.saveCheckpoint(update.checkpoint);
      if (update.clearCheckpoint) this.database.prepare("DELETE FROM checkpoints WHERE run_id = ?").run(update.runId);

      this.insertAudit(
        "run.progressed",
        "run",
        update.runId,
        update.runId,
        {
          from: update.expectedRunState,
          to: update.runState,
          revision: update.expectedRunRevision + 1,
          ...(update.step ? { stepId: update.step.id, stepState: update.step.state } : {}),
          ...(update.checkpoint ? { checkpointVersion: update.checkpoint.version } : {}),
          ...(update.clearCheckpoint ? { checkpointCleared: true } : {}),
        },
        update.runUpdatedAt,
      );
    })();
  }

  async getRun(runId: string): Promise<Run | undefined> {
    const row = this.database.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as RunRow | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      revision: row.revision,
      state: row.state,
      context: parseJson<ExecutionContext>(row.context_json),
      ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
      ...(row.turn_id ? { turnId: row.turn_id } : {}),
      ...(row.parent_run_id ? { parentRunId: row.parent_run_id } : {}),
      ...(row.waiting_reason ? { waitingReason: row.waiting_reason } : {}),
      ...(row.interruption_json ? { interruption: parseJson<NonNullable<Run["interruption"]>>(row.interruption_json) } : {}),
      resumeEligibility: row.resume_eligibility,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async getStep(stepId: string): Promise<Step | undefined> {
    const row = this.database.prepare("SELECT * FROM steps WHERE id = ?").get(stepId) as StepRow | undefined;
    return row ? {
      id: row.id,
      runId: row.run_id,
      revision: row.revision,
      sequence: row.sequence,
      kind: row.kind,
      state: row.state,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    } : undefined;
  }

  async getOperation(operationId: string): Promise<Operation | undefined> {
    const row = this.database.prepare("SELECT * FROM operations WHERE id = ?").get(operationId) as OperationRow | undefined;
    return row ? {
      id: row.id,
      stepId: row.step_id,
      kind: row.kind,
      state: row.state,
      capability: row.capability,
      authorizationTier: row.authorization_tier,
      sideEffect: row.side_effect,
      ...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : {}),
      authorizationDecisionId: row.authorization_decision_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    } : undefined;
  }

  async getAuthorizationDecision(decisionId: string): Promise<AuthorizationDecisionRecord | undefined> {
    const row = this.database.prepare("SELECT * FROM authorization_decisions WHERE id = ?").get(decisionId) as DecisionRow | undefined;
    return row ? {
      id: row.id,
      operationId: row.operation_id,
      allow: row.allow === 1,
      reason: row.reason,
      policyId: row.policy_id,
      principalId: row.principal_id,
      capability: row.capability,
      tier: row.tier,
      ...(row.resource_json ? { resource: parseJson<NonNullable<AuthorizationDecisionRecord["resource"]>>(row.resource_json) } : {}),
      decidedAt: row.decided_at,
    } : undefined;
  }

  async getOperationResult(operationId: string): Promise<OperationResult | undefined> {
    const row = this.database.prepare("SELECT * FROM operation_results WHERE operation_id = ?").get(operationId) as ResultRow | undefined;
    return row ? {
      operationId: row.operation_id,
      outcome: row.outcome,
      effectStatus: row.effect_status,
      ...(row.output_json !== null ? { output: parseJson<JsonValue>(row.output_json) } : {}),
      ...(row.error_json ? { error: parseJson<NonNullable<OperationResult["error"]>>(row.error_json) } : {}),
      completedAt: row.completed_at,
    } : undefined;
  }

  async getCheckpoint(runId: string): Promise<RunCheckpoint | undefined> {
    const row = this.database.prepare("SELECT * FROM checkpoints WHERE run_id = ?").get(runId) as CheckpointRow | undefined;
    return row ? {
      runId: row.run_id,
      version: row.version,
      data: parseJson<JsonValue>(row.data_json),
      updatedAt: row.updated_at,
    } : undefined;
  }

  async listAuditEvents(runId: string): Promise<readonly AuditEvent[]> {
    const rows = this.database.prepare("SELECT * FROM audit_events WHERE run_id = ? ORDER BY sequence")
      .all(runId) as AuditRow[];
    return rows.map(row => ({
      sequence: row.sequence,
      kind: row.kind,
      entityType: row.entity_type,
      entityId: row.entity_id,
      runId: row.run_id,
      data: parseJson<JsonValue>(row.data_json),
      occurredAt: row.occurred_at,
    }));
  }

  close(): void {
    this.database.close();
  }

  private operationState(operationId: string): Operation["state"] {
    const row = this.database.prepare("SELECT state FROM operations WHERE id = ?").get(operationId) as { state: Operation["state"] } | undefined;
    if (!row) throw new ExecutionStoreConflictError(`operation ${operationId} does not exist`);
    return row.state;
  }

  private runIdForOperation(operationId: string): string {
    const row = this.database.prepare(`
      SELECT steps.run_id AS run_id
      FROM operations JOIN steps ON steps.id = operations.step_id
      WHERE operations.id = ?
    `).get(operationId) as { run_id: string } | undefined;
    if (!row) throw new ExecutionStoreConflictError(`operation ${operationId} is not attached to a run`);
    return row.run_id;
  }

  private saveCheckpoint(checkpoint: RunCheckpoint): void {
    if (!Number.isSafeInteger(checkpoint.version) || checkpoint.version < 1) {
      throw new TypeError("checkpoint version must be a positive safe integer");
    }
    const result = this.database.prepare(`
      INSERT INTO checkpoints(run_id, version, data_json, updated_at)
      SELECT ?, ?, ?, ? WHERE ? = 1
      ON CONFLICT(run_id) DO UPDATE SET
        version = excluded.version,
        data_json = excluded.data_json,
        updated_at = excluded.updated_at
      WHERE excluded.version = checkpoints.version + 1
    `).run(checkpoint.runId, checkpoint.version, json(checkpoint.data), checkpoint.updatedAt, checkpoint.version);
    expectOne(result.changes, `checkpoint ${checkpoint.runId} version is stale or skipped`);
  }

  private insertAudit(
    kind: string,
    entityType: AuditEvent["entityType"],
    entityId: string,
    runId: string,
    data: JsonValue,
    occurredAt: string,
  ): void {
    this.database.prepare(`
      INSERT INTO audit_events(kind, entity_type, entity_id, run_id, data_json, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(kind, entityType, entityId, runId, json(data), occurredAt);
  }
}
