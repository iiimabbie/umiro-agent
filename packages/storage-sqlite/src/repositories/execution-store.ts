import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
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
  type CompleteRunWithOutput,
  type Conversation,
  type ConversationStore,
  type ConversationIngressStore,
  type DeliveryIntent,
  type DelegationRecord,
  type DelegationStore,
  type ExecutionContext,
  type ExecutionProgressUpdate,
  type ExecutionStore,
  type JsonObject,
  type JsonValue,
  type ModelCallRecord,
  type Operation,
  type OperationResult,
  type Run,
  type RunCheckpoint,
  type RunOutput,
  type RunState,
  type Step,
  type StepState,
  type Turn,
  type AppendTurnRequest,
  type UpdateConversationStateRequest,
  type IngestInputEventRequest,
  type IngestInputEventResult,
  type PersistedTransportIdentity,
  type SearchHit,
  type VisibilityScope,
  type EmbeddingJob,
  type CreateScheduledTrigger,
  type ScheduledOccurrence,
  type ScheduledTrigger,
  type Artifact,
  type ArtifactStore,
  type CreateArtifactRequest,
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
  input_json: string;
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
  interaction_requirement: AuthorizationDecisionRecord["interactionRequirement"];
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

interface ConversationRow {
  id: string;
  revision: number;
  state: Conversation["state"];
  created_at: string;
  updated_at: string;
}

interface TurnRow {
  id: string;
  conversation_id: string;
  sequence: number;
  actor_principal_id: string;
  actor_transport: string | null;
  actor_external_id: string | null;
  input_event_id: string;
  primary_run_id: string | null;
  content_json: string;
  reply_to_turn_id: string | null;
  created_at: string;
}

interface TriggerRow { id: string; revision: number; name: string; enabled: number; schedule_json: string; timezone: string; job_ref: string; input_json: string; creator_principal_id: string; creator_roles_json: string; authority_json: string; destination_json: string | null; misfire_policy: ScheduledTrigger["misfirePolicy"]; max_attempts: number; retry_backoff_ms: number; next_fire_at: string | null; created_at: string; updated_at: string }
interface OccurrenceRow { id: string; trigger_id: string; scheduled_for: string; status: ScheduledOccurrence["status"]; attempts: number; run_id: string; next_retry_at: string | null; error: string | null; claimed_at: string; completed_at: string | null }
interface ArtifactRow { id: string; owner_principal_id: string; visibility: Artifact["visibility"]; media_type: string; filename: string | null; size: number; sha256: string; location: string; parent_source_json: string | null; state: Artifact["state"]; created_at: string; updated_at: string }

interface DelegationRow {
  id: string;
  parent_run_id: string;
  child_run_id: string;
  idempotency_key: string;
  task_json: string;
  budget_ceiling_json: string | null;
  agent_profile_ref: string | null;
  created_at: string;
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

function artifactFromRow(row: ArtifactRow): Artifact {
  const artifact: Artifact = {
    id: row.id,
    ownerPrincipalId: row.owner_principal_id,
    visibility: row.visibility,
    mediaType: row.media_type,
    ...(row.filename ? { filename: row.filename } : {}),
    size: row.size,
    sha256: row.sha256,
    location: row.location,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.parent_source_json) return { ...artifact, parentSource: parseJson<NonNullable<Artifact["parentSource"]>>(row.parent_source_json) };
  return artifact;
}

export class SQLiteExecutionStore implements ExecutionStore, ConversationStore, ConversationIngressStore, DelegationStore, ArtifactStore {
  private readonly database: Database.Database;

  constructor(filename: string) {
    if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
    this.database = new Database(filename);
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("busy_timeout = 5000");
    if (filename !== ":memory:") this.database.pragma("journal_mode = WAL");
    this.database.pragma("synchronous = FULL");
    migrate(this.database);
    this.seedEmbeddingJobs();
  }

  async find(transport: string, externalId: string): Promise<PersistedTransportIdentity | undefined> {
    const row = this.database.prepare("SELECT transport, external_id, principal_id, display_name FROM transport_identities WHERE transport = ? AND external_id = ?")
      .get(transport, externalId) as { transport: string; external_id: string; principal_id: string; display_name: string | null } | undefined;
    return row ? { transport: row.transport, externalId: row.external_id, principalId: row.principal_id, ...(row.display_name ? { displayName: row.display_name } : {}) } : undefined;
  }

  async createArtifact(request: CreateArtifactRequest): Promise<void> {
    const a = request.artifact;
    if (a.size < 0 || !/^[a-f0-9]{64}$/i.test(a.sha256)) throw new TypeError("invalid artifact metadata");
    this.database.prepare(`INSERT INTO artifacts(id, owner_principal_id, visibility, media_type, filename, size, sha256, location, parent_source_json, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(a.id, a.ownerPrincipalId, a.visibility, a.mediaType, a.filename ?? null, a.size, a.sha256, a.location, a.parentSource ? json(a.parentSource) : null, a.state, a.createdAt, a.updatedAt);
  }

  async getArtifact(id: string): Promise<Artifact | undefined> {
    const row = this.database.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as ArtifactRow | undefined;
    return row ? artifactFromRow(row) : undefined;
  }

  async listArtifacts(ownerPrincipalId?: string): Promise<readonly Artifact[]> {
    const rows = (ownerPrincipalId
      ? this.database.prepare("SELECT * FROM artifacts WHERE owner_principal_id = ? AND state <> 'deleted' ORDER BY created_at, id").all(ownerPrincipalId)
      : this.database.prepare("SELECT * FROM artifacts WHERE state <> 'deleted' ORDER BY created_at, id").all()) as ArtifactRow[];
    return rows.map(artifactFromRow);
  }

  async updateArtifactState(id: string, state: Artifact["state"], updatedAt: string): Promise<void> {
    const result = this.database.prepare("UPDATE artifacts SET state = ?, updated_at = ? WHERE id = ? AND state <> 'deleted'").run(state, updatedAt, id);
    expectOne(result.changes, `artifact ${id} not found or deleted`);
  }

  async deleteArtifact(id: string, deletedAt: string): Promise<void> {
    const result = this.database.prepare("UPDATE artifacts SET state = 'deleted', updated_at = ? WHERE id = ? AND state <> 'deleted'").run(deletedAt, id);
    expectOne(result.changes, `artifact ${id} not found or already deleted`);
  }

  canAccessArtifact(artifact: Artifact, principalId: string, visibility: Artifact["visibility"]): boolean {
    if (artifact.state === "deleted") return false;
    if (visibility === "public" || artifact.visibility === "public") return true;
    if (visibility === "shared" && artifact.visibility !== "private") return true;
    return artifact.ownerPrincipalId === principalId;
  }

  async findOrCreate(identity: PersistedTransportIdentity, createdAt: string): Promise<PersistedTransportIdentity> {
    this.database.prepare(`INSERT INTO transport_identities(transport, external_id, principal_id, display_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(transport, external_id) DO UPDATE SET display_name = COALESCE(excluded.display_name, display_name), updated_at = excluded.updated_at`)
      .run(identity.transport, identity.externalId, identity.principalId, identity.displayName ?? null, createdAt, createdAt);
    return (await this.find(identity.transport, identity.externalId))!;
  }

  async createConversationWithTurn(conversation: Conversation, firstTurn: Turn): Promise<void> {
    if (conversation.revision !== 0 || conversation.state !== "active") {
      throw new TypeError("new conversations must begin active at revision zero");
    }
    if (firstTurn.conversationId !== conversation.id || firstTurn.sequence !== 0) {
      throw new TypeError("first Turn must belong to the Conversation at sequence zero");
    }
    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO conversations(id, revision, state, created_at, updated_at)
        VALUES (?, 0, 'active', ?, ?)
      `).run(conversation.id, conversation.createdAt, conversation.updatedAt);
      this.insertTurn(firstTurn);
    })();
  }

  async ingestInputEvent(request: IngestInputEventRequest): Promise<IngestInputEventResult> {
    return this.database.transaction(() => {
      const duplicate = this.database.prepare("SELECT * FROM turns WHERE input_event_id = ?")
        .get(request.event.id) as TurnRow | undefined;
      if (duplicate) {
        const conversation = this.database.prepare("SELECT * FROM conversations WHERE id = ?")
          .get(duplicate.conversation_id) as ConversationRow | undefined;
        if (!conversation) throw new Error(`Turn ${duplicate.id} references a missing Conversation`);
        return {
          conversation: this.conversationFromRow(conversation),
          turn: this.turnFromRow(duplicate),
          duplicate: true,
          conversationCreated: false,
        };
      }

      const binding = this.database.prepare(`
        SELECT conversation_id FROM conversation_bindings WHERE transport = ? AND external_id = ?
      `).get(request.event.conversation.transport, request.event.conversation.externalId) as { conversation_id: string } | undefined;

      if (!binding) {
        const conversation: Conversation = {
          id: request.newConversationId,
          revision: 0,
          state: "active",
          createdAt: request.createdAt,
          updatedAt: request.createdAt,
        };
        const turn: Turn = {
          id: request.newTurnId,
          conversationId: conversation.id,
          sequence: 0,
          actorPrincipalId: request.actorPrincipalId,
          actorIdentity: { transport: request.event.identity.transport, externalId: request.event.identity.externalId },
          inputEventId: request.event.id,
          primaryRunId: request.newRunId,
          content: structuredClone(request.event.content),
          createdAt: request.createdAt,
        };
        this.database.prepare(`
          INSERT INTO conversations(id, revision, state, created_at, updated_at) VALUES (?, 0, 'active', ?, ?)
        `).run(conversation.id, conversation.createdAt, conversation.updatedAt);
        this.database.prepare(`
          INSERT INTO conversation_bindings(transport, external_id, kind, conversation_id, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          request.event.conversation.transport,
          request.event.conversation.externalId,
          request.event.conversation.kind,
          conversation.id,
          request.createdAt,
        );
        this.insertTurn(turn);
        return { conversation, turn, duplicate: false, conversationCreated: true };
      }

      const row = this.database.prepare("SELECT * FROM conversations WHERE id = ?")
        .get(binding.conversation_id) as ConversationRow | undefined;
      if (!row || row.state !== "active") throw new Error(`bound Conversation is missing or archived: ${binding.conversation_id}`);
      const next = this.database.prepare("SELECT COALESCE(MAX(sequence) + 1, 0) AS sequence FROM turns WHERE conversation_id = ?")
        .get(row.id) as { sequence: number };
      const turn: Turn = {
        id: request.newTurnId,
        conversationId: row.id,
        sequence: next.sequence,
        actorPrincipalId: request.actorPrincipalId,
        actorIdentity: { transport: request.event.identity.transport, externalId: request.event.identity.externalId },
        inputEventId: request.event.id,
        primaryRunId: request.newRunId,
        content: structuredClone(request.event.content),
        createdAt: request.createdAt,
      };
      this.insertTurn(turn);
      const update = this.database.prepare(`
        UPDATE conversations SET revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ? AND state = 'active'
      `).run(request.createdAt, row.id, row.revision);
      expectOne(update.changes, `conversation ${row.id} changed concurrently`);
      return {
        conversation: { ...this.conversationFromRow(row), revision: row.revision + 1, updatedAt: request.createdAt },
        turn,
        duplicate: false,
        conversationCreated: false,
      };
    })();
  }

  async appendTurn(request: AppendTurnRequest): Promise<void> {
    this.database.transaction(() => {
      const current = this.database.prepare("SELECT revision, state FROM conversations WHERE id = ?")
        .get(request.turn.conversationId) as { revision: number; state: Conversation["state"] } | undefined;
      if (!current || current.revision !== request.expectedConversationRevision || current.state !== "active") {
        throw new ExecutionStoreConflictError(`conversation ${request.turn.conversationId} changed concurrently or is not active`);
      }
      const next = this.database.prepare("SELECT COALESCE(MAX(sequence) + 1, 0) AS sequence FROM turns WHERE conversation_id = ?")
        .get(request.turn.conversationId) as { sequence: number };
      if (request.turn.sequence !== next.sequence) {
        throw new ExecutionStoreConflictError(`Turn sequence must be ${next.sequence}`);
      }
      this.insertTurn(request.turn);
      const update = this.database.prepare(`
        UPDATE conversations SET revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ? AND state = 'active'
      `).run(request.conversationUpdatedAt, request.turn.conversationId, request.expectedConversationRevision);
      expectOne(update.changes, `conversation ${request.turn.conversationId} changed concurrently`);
    })();
  }

  async updateConversationState(request: UpdateConversationStateRequest): Promise<void> {
    if (request.expectedState === request.state) throw new TypeError("conversation state update must change state");
    if (request.expectedState !== "active" || request.state !== "archived") {
      throw new TypeError(`invalid conversation transition: ${request.expectedState} -> ${request.state}`);
    }
    const update = this.database.prepare(`
      UPDATE conversations SET revision = revision + 1, state = ?, updated_at = ?
      WHERE id = ? AND revision = ? AND state = ?
    `).run(request.state, request.updatedAt, request.conversationId, request.expectedRevision, request.expectedState);
    expectOne(update.changes, `conversation ${request.conversationId} changed concurrently`);
  }

  async getConversation(conversationId: string): Promise<Conversation | undefined> {
    const row = this.database.prepare("SELECT * FROM conversations WHERE id = ?").get(conversationId) as ConversationRow | undefined;
    return row ? this.conversationFromRow(row) : undefined;
  }

  async getTurn(turnId: string): Promise<Turn | undefined> {
    const row = this.database.prepare("SELECT * FROM turns WHERE id = ?").get(turnId) as TurnRow | undefined;
    return row ? this.turnFromRow(row) : undefined;
  }

  async getTurnByInputEventId(inputEventId: string): Promise<Turn | undefined> {
    const row = this.database.prepare("SELECT * FROM turns WHERE input_event_id = ?").get(inputEventId) as TurnRow | undefined;
    return row ? this.turnFromRow(row) : undefined;
  }

  async listTurns(conversationId: string): Promise<readonly Turn[]> {
    const rows = this.database.prepare("SELECT * FROM turns WHERE conversation_id = ? ORDER BY sequence")
      .all(conversationId) as TurnRow[];
    return rows.map(row => this.turnFromRow(row));
  }

  private insertTurn(turn: Turn): void {
    this.database.prepare(`
      INSERT INTO turns(id, conversation_id, sequence, actor_principal_id, actor_transport, actor_external_id, input_event_id, primary_run_id, content_json, reply_to_turn_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      turn.id,
      turn.conversationId,
      turn.sequence,
      turn.actorPrincipalId,
      turn.actorIdentity?.transport ?? null,
      turn.actorIdentity?.externalId ?? null,
      turn.inputEventId,
      turn.primaryRunId ?? null,
      json(turn.content),
      turn.replyToTurnId ?? null,
      turn.createdAt,
    );
    const text = turn.content.filter(block => block.type === "text").map(block => block.text).join("\n");
    if (text.trim()) this.database.prepare("INSERT INTO conversation_fts(turn_id, conversation_id, actor_principal_id, text) VALUES (?, ?, ?, ?)")
      .run(turn.id, turn.conversationId, turn.actorPrincipalId, text);
    if (text.trim()) this.enqueueEmbedding(turn.id, text);
  }

  private triggerFromRow(row: TriggerRow): ScheduledTrigger {
    return { id: row.id, revision: row.revision, name: row.name, enabled: row.enabled === 1, schedule: parseJson<ScheduledTrigger["schedule"]>(row.schedule_json), timezone: row.timezone, jobRef: row.job_ref, input: parseJson<JsonObject>(row.input_json), creatorPrincipalId: row.creator_principal_id, creatorRoles: parseJson<ScheduledTrigger["creatorRoles"]>(row.creator_roles_json), authority: parseJson<ScheduledTrigger["authority"]>(row.authority_json), ...(row.destination_json ? { destination: parseJson<JsonObject>(row.destination_json) } : {}), misfirePolicy: row.misfire_policy, maxAttempts: row.max_attempts, retryBackoffMs: row.retry_backoff_ms, nextFireAt: row.next_fire_at, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  private occurrenceFromRow(row: OccurrenceRow): ScheduledOccurrence {
    return { id: row.id, triggerId: row.trigger_id, scheduledFor: row.scheduled_for, status: row.status, attempts: row.attempts, runId: row.run_id, ...(row.next_retry_at ? { nextRetryAt: row.next_retry_at } : {}), ...(row.error ? { error: row.error } : {}), claimedAt: row.claimed_at, ...(row.completed_at ? { completedAt: row.completed_at } : {}) };
  }
  async createScheduledTrigger(trigger: CreateScheduledTrigger): Promise<ScheduledTrigger> {
    this.database.prepare(`INSERT INTO scheduled_triggers(id, revision, name, enabled, schedule_json, timezone, job_ref, input_json, creator_principal_id, creator_roles_json, authority_json, destination_json, misfire_policy, max_attempts, retry_backoff_ms, next_fire_at, created_at, updated_at)
      VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(trigger.id, trigger.name, trigger.enabled ? 1 : 0, json(trigger.schedule), trigger.timezone, trigger.jobRef, json(trigger.input), trigger.creatorPrincipalId, json([...trigger.creatorRoles]), json(trigger.authority), trigger.destination ? json(trigger.destination) : null, trigger.misfirePolicy, trigger.maxAttempts, trigger.retryBackoffMs, trigger.nextFireAt, trigger.createdAt, trigger.createdAt);
    return (await this.getScheduledTrigger(trigger.id))!;
  }
  async listScheduledTriggers(): Promise<readonly ScheduledTrigger[]> { return (this.database.prepare("SELECT * FROM scheduled_triggers ORDER BY created_at, id").all() as TriggerRow[]).map(row => this.triggerFromRow(row)); }
  async getScheduledTrigger(id: string): Promise<ScheduledTrigger | undefined> { const row = this.database.prepare("SELECT * FROM scheduled_triggers WHERE id=?").get(id) as TriggerRow | undefined; return row ? this.triggerFromRow(row) : undefined; }
  async getScheduledOccurrence(id: string): Promise<ScheduledOccurrence | undefined> { const row = this.database.prepare("SELECT * FROM scheduled_occurrences WHERE id=?").get(id) as OccurrenceRow | undefined; return row ? this.occurrenceFromRow(row) : undefined; }
  async setScheduledTriggerEnabled(id: string, enabled: boolean, nextFireAt: string | null, expectedRevision: number, updatedAt: string): Promise<ScheduledTrigger> {
    const update = this.database.prepare("UPDATE scheduled_triggers SET enabled=?, next_fire_at=?, revision=revision+1, updated_at=? WHERE id=? AND revision=?").run(enabled ? 1 : 0, nextFireAt, updatedAt, id, expectedRevision);
    expectOne(update.changes, `scheduled trigger changed: ${id}`); return (await this.getScheduledTrigger(id))!;
  }
  async deleteScheduledTrigger(id: string): Promise<boolean> { return this.database.prepare("DELETE FROM scheduled_triggers WHERE id=?").run(id).changes === 1; }
  async listDueScheduledTriggers(now: string, limit: number): Promise<readonly ScheduledTrigger[]> {
    return (this.database.prepare("SELECT * FROM scheduled_triggers WHERE enabled=1 AND next_fire_at IS NOT NULL AND next_fire_at <= ? ORDER BY next_fire_at, id LIMIT ?").all(now, limit) as TriggerRow[]).map(row => this.triggerFromRow(row));
  }
  async claimScheduledOccurrence(triggerId: string, expectedRevision: number, scheduledFor: string, nextFireAt: string | null, disable: boolean, occurrenceId: string, runId: string, claimedAt: string): Promise<ScheduledOccurrence | undefined> {
    return this.database.transaction(() => {
      const exists = this.database.prepare("SELECT 1 FROM scheduled_occurrences WHERE trigger_id=? AND scheduled_for=?").get(triggerId, scheduledFor); if (exists) return undefined;
      const updated = this.database.prepare("UPDATE scheduled_triggers SET revision=revision+1, next_fire_at=?, enabled=?, updated_at=? WHERE id=? AND revision=? AND enabled=1 AND next_fire_at=?")
        .run(nextFireAt, disable ? 0 : 1, claimedAt, triggerId, expectedRevision, scheduledFor);
      if (updated.changes !== 1) return undefined;
      this.database.prepare("INSERT INTO scheduled_occurrences(id, trigger_id, scheduled_for, status, attempts, run_id, claimed_at) VALUES (?, ?, ?, 'running', 1, ?, ?)").run(occurrenceId, triggerId, scheduledFor, runId, claimedAt);
      this.database.prepare("INSERT INTO scheduled_occurrence_attempts(occurrence_id, attempt, run_id, status, claimed_at) VALUES (?, 1, ?, 'running', ?)").run(occurrenceId, runId, claimedAt);
      return this.occurrenceFromRow(this.database.prepare("SELECT * FROM scheduled_occurrences WHERE id=?").get(occurrenceId) as OccurrenceRow);
    })();
  }
  async listRetryableScheduledOccurrences(now: string, limit: number): Promise<readonly ScheduledOccurrence[]> { return (this.database.prepare("SELECT * FROM scheduled_occurrences WHERE status='failed' AND next_retry_at IS NOT NULL AND next_retry_at <= ? ORDER BY next_retry_at, id LIMIT ?").all(now, limit) as OccurrenceRow[]).map(row => this.occurrenceFromRow(row)); }
  async claimScheduledRetry(id: string, expectedAttempts: number, runId: string, claimedAt: string): Promise<ScheduledOccurrence | undefined> {
    return this.database.transaction(() => {
      const update = this.database.prepare("UPDATE scheduled_occurrences SET status='running', attempts=attempts+1, run_id=?, next_retry_at=NULL, error=NULL, claimed_at=?, completed_at=NULL WHERE id=? AND status='failed' AND attempts=?").run(runId, claimedAt, id, expectedAttempts);
      if (update.changes !== 1) return undefined;
      this.database.prepare("INSERT INTO scheduled_occurrence_attempts(occurrence_id, attempt, run_id, status, claimed_at) VALUES (?, ?, ?, 'running', ?)").run(id, expectedAttempts + 1, runId, claimedAt);
      return this.occurrenceFromRow(this.database.prepare("SELECT * FROM scheduled_occurrences WHERE id=?").get(id) as OccurrenceRow);
    })();
  }
  async completeScheduledOccurrence(id: string, completedAt: string): Promise<void> { this.database.transaction(() => { expectOne(this.database.prepare("UPDATE scheduled_occurrences SET status='succeeded', completed_at=?, next_retry_at=NULL, error=NULL WHERE id=? AND status='running'").run(completedAt, id).changes, `scheduled occurrence changed: ${id}`); this.database.prepare("UPDATE scheduled_occurrence_attempts SET status='succeeded', completed_at=? WHERE occurrence_id=? AND status='running'").run(completedAt, id); })(); }
  async failScheduledOccurrence(id: string, error: string, nextRetryAt: string | undefined, completedAt: string): Promise<void> { this.database.transaction(() => { const message = error.slice(0, 2000); expectOne(this.database.prepare("UPDATE scheduled_occurrences SET status='failed', error=?, next_retry_at=?, completed_at=? WHERE id=? AND status='running'").run(message, nextRetryAt ?? null, completedAt, id).changes, `scheduled occurrence changed: ${id}`); this.database.prepare("UPDATE scheduled_occurrence_attempts SET status='failed', error=?, completed_at=? WHERE occurrence_id=? AND status='running'").run(message, completedAt, id); })(); }
  async recoverScheduledOccurrences(recoveredAt: string): Promise<number> {
    return this.database.transaction(() => {
      const rows = this.database.prepare(`SELECT o.id, o.attempts, o.run_id, t.max_attempts, r.state AS run_state FROM scheduled_occurrences o JOIN scheduled_triggers t ON t.id=o.trigger_id LEFT JOIN runs r ON r.id=o.run_id WHERE o.status='running'`).all() as Array<{ id: string; attempts: number; run_id: string; max_attempts: number; run_state: RunState | null }>;
      for (const row of rows) {
        if (row.run_state === "succeeded") { this.database.prepare("UPDATE scheduled_occurrences SET status='succeeded', completed_at=? WHERE id=?").run(recoveredAt, row.id); this.database.prepare("UPDATE scheduled_occurrence_attempts SET status='succeeded', completed_at=? WHERE occurrence_id=? AND attempt=?").run(recoveredAt, row.id, row.attempts); }
        else { const retry = row.run_state === "waiting" || row.attempts >= row.max_attempts ? null : recoveredAt; this.database.prepare("UPDATE scheduled_occurrences SET status='failed', error='daemon restarted during scheduled execution', next_retry_at=?, completed_at=? WHERE id=?").run(retry, recoveredAt, row.id); this.database.prepare("UPDATE scheduled_occurrence_attempts SET status='failed', error='daemon restarted during scheduled execution', completed_at=? WHERE occurrence_id=? AND attempt=?").run(recoveredAt, row.id, row.attempts); }
      }
      return rows.length;
    })();
  }

  private contentHash(text: string): string { return createHash("sha256").update(text).digest("hex"); }

  private enqueueEmbedding(turnId: string, text: string): void {
    const hash = this.contentHash(text);
    const existing = this.database.prepare("SELECT content_hash FROM conversation_embeddings WHERE turn_id = ?").get(turnId) as { content_hash: string } | undefined;
    if (existing?.content_hash === hash) return;
    this.database.prepare(`INSERT INTO conversation_embedding_jobs(turn_id, content_hash, status, attempts, next_retry_at, last_error, updated_at)
      VALUES (?, ?, 'pending', 0, NULL, NULL, ?)
      ON CONFLICT(turn_id) DO UPDATE SET content_hash=excluded.content_hash, status='pending', attempts=0, next_retry_at=NULL, last_error=NULL, updated_at=excluded.updated_at`)
      .run(turnId, hash, new Date().toISOString());
  }

  private seedEmbeddingJobs(): void {
    const rows = this.database.prepare(`SELECT t.id, t.content_json FROM turns t LEFT JOIN conversation_embeddings e ON e.turn_id=t.id WHERE e.turn_id IS NULL`).all() as Array<{ id: string; content_json: string }>;
    for (const row of rows) {
      const content = parseJson<Turn["content"]>(row.content_json);
      const text = content.filter(block => block.type === "text").map(block => block.text).join("\n");
      if (text.trim()) this.enqueueEmbedding(row.id, text);
    }
  }

  async claimEmbeddingJobs(limit: number, now: string, staleBefore: string): Promise<readonly EmbeddingJob[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError("embedding claim limit must be between 1 and 100");
    return this.database.transaction(() => {
      const rows = this.database.prepare(`SELECT j.turn_id, j.content_hash, j.attempts, t.content_json
        FROM conversation_embedding_jobs j JOIN turns t ON t.id=j.turn_id
        WHERE (j.status='pending' OR (j.status='failed' AND (j.next_retry_at IS NULL OR j.next_retry_at <= ?)) OR (j.status='processing' AND j.updated_at < ?))
        ORDER BY j.updated_at, j.turn_id LIMIT ?`).all(now, staleBefore, limit) as Array<{ turn_id: string; content_hash: string; attempts: number; content_json: string }>;
      const update = this.database.prepare("UPDATE conversation_embedding_jobs SET status='processing', attempts=attempts+1, updated_at=? WHERE turn_id=? AND content_hash=?");
      return rows.flatMap(row => {
        if (update.run(now, row.turn_id, row.content_hash).changes !== 1) return [];
        const content = parseJson<Turn["content"]>(row.content_json); const text = content.filter(block => block.type === "text").map(block => block.text).join("\n");
        return [{ turnId: row.turn_id, text, contentHash: row.content_hash, attempts: row.attempts + 1 }];
      });
    })();
  }

  async completeEmbeddingJob(turnId: string, contentHash: string, model: string, vector: readonly number[], now: string): Promise<void> {
    if (!vector.length || vector.some(value => !Number.isFinite(value))) throw new TypeError("embedding vector must contain finite values");
    this.database.transaction(() => {
      const job = this.database.prepare("SELECT content_hash FROM conversation_embedding_jobs WHERE turn_id=? AND status='processing'").get(turnId) as { content_hash: string } | undefined;
      if (job?.content_hash !== contentHash) throw new ExecutionStoreConflictError(`embedding job changed: ${turnId}`);
      this.database.prepare(`INSERT INTO conversation_embeddings(turn_id, content_hash, model, dimensions, vector_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(turn_id) DO UPDATE SET content_hash=excluded.content_hash, model=excluded.model, dimensions=excluded.dimensions, vector_json=excluded.vector_json, updated_at=excluded.updated_at`)
        .run(turnId, contentHash, model, vector.length, json([...vector]), now);
      this.database.prepare("DELETE FROM conversation_embedding_jobs WHERE turn_id=? AND content_hash=?").run(turnId, contentHash);
    })();
  }

  async failEmbeddingJob(turnId: string, contentHash: string, error: string, nextRetryAt: string, now: string): Promise<void> {
    const update = this.database.prepare(`UPDATE conversation_embedding_jobs SET status='failed', last_error=?, next_retry_at=?, updated_at=? WHERE turn_id=? AND content_hash=? AND status='processing'`)
      .run(error.slice(0, 2000), nextRetryAt, now, turnId, contentHash);
    expectOne(update.changes, `embedding job changed: ${turnId}`);
  }

  async semanticSearch(vector: readonly number[], model: string, limit: number, visibility: VisibilityScope): Promise<readonly SearchHit[]> {
    if (!vector.length || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError("invalid semantic search input");
    const rows = this.database.prepare(`SELECT e.turn_id, e.vector_json, e.dimensions, f.conversation_id, f.actor_principal_id, f.text
      FROM conversation_embeddings e JOIN conversation_fts f ON f.turn_id=e.turn_id WHERE e.model=? AND e.dimensions=?`).all(model, vector.length) as Array<{ turn_id: string; vector_json: string; dimensions: number; conversation_id: string; actor_principal_id: string; text: string }>;
    const visible = rows.filter(row => visibility.kind === "all" || visibility.principalIds.includes(row.actor_principal_id) || visibility.resources.some(resource => resource.kind === "conversation" && resource.id === row.conversation_id));
    const norm = (values: readonly number[]) => Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)); const queryNorm = norm(vector);
    if (!queryNorm) return [];
    return visible.map(row => {
      const candidate = parseJson<number[]>(row.vector_json); const denominator = queryNorm * norm(candidate); const similarity = denominator ? candidate.reduce((sum, value, index) => sum + value * (vector[index] ?? 0), 0) / denominator : -1;
      return { turnId: row.turn_id, conversationId: row.conversation_id, actorPrincipalId: row.actor_principal_id, text: row.text, rank: 1 - similarity };
    }).sort((left, right) => left.rank - right.rank).slice(0, limit);
  }

  async rebuildEmbeddingProjection(): Promise<void> {
    this.database.transaction(() => { this.database.prepare("DELETE FROM conversation_embeddings").run(); this.database.prepare("DELETE FROM conversation_embedding_jobs").run(); this.seedEmbeddingJobs(); })();
  }

  async search(query: string, limit: number, visibility: VisibilityScope): Promise<readonly SearchHit[]> {
    const normalized = query.trim();
    if (!normalized) return [];
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError("search limit must be between 1 and 100");
    const allowed = visibility.kind === "all" ? undefined : {
      principals: [...new Set(visibility.principalIds)],
      conversations: [...new Set(visibility.resources.filter(resource => resource.kind === "conversation").map(resource => resource.id))],
    };
    if (allowed && allowed.principals.length === 0 && allowed.conversations.length === 0) return [];
    const filters: string[] = []; const filterValues: string[] = [];
    if (allowed) {
      if (allowed.principals.length) { filters.push(`actor_principal_id IN (${allowed.principals.map(() => "?").join(",")})`); filterValues.push(...allowed.principals); }
      if (allowed.conversations.length) { filters.push(`conversation_id IN (${allowed.conversations.map(() => "?").join(",")})`); filterValues.push(...allowed.conversations); }
    }
    const visibleSql = filters.length ? ` AND (${filters.join(" OR ")})` : "";
    if ([...normalized].length < 3) {
      return this.database.prepare(`SELECT turn_id AS turnId, conversation_id AS conversationId, actor_principal_id AS actorPrincipalId, text, 0 AS rank
        FROM conversation_fts WHERE text LIKE ? ESCAPE '\\'${visibleSql} LIMIT ?`).all(`%${normalized.replace(/[\\%_]/g, "\\$&")}%`, ...filterValues, limit) as SearchHit[];
    }
    const ftsQuery = `"${normalized.replace(/"/g, '""')}"`;
    const rows = this.database.prepare(`SELECT turn_id AS turnId, conversation_id AS conversationId, actor_principal_id AS actorPrincipalId, text, bm25(conversation_fts) AS rank
      FROM conversation_fts WHERE conversation_fts MATCH ?${visibleSql} ORDER BY rank LIMIT ?`).all(ftsQuery, ...filterValues, limit) as SearchHit[];
    return rows;
  }

  async rebuildSearchProjection(): Promise<void> {
    this.database.transaction(() => {
      this.database.prepare("DELETE FROM conversation_fts").run();
      const rows = this.database.prepare("SELECT * FROM turns ORDER BY conversation_id, sequence").all() as TurnRow[];
      const insert = this.database.prepare("INSERT INTO conversation_fts(turn_id, conversation_id, actor_principal_id, text) VALUES (?, ?, ?, ?)");
      for (const row of rows) {
        const content = parseJson<Turn["content"]>(row.content_json);
        const text = content.filter(block => block.type === "text").map(block => block.text).join("\n");
        if (text.trim()) insert.run(row.id, row.conversation_id, row.actor_principal_id, text);
      }
    })();
  }

  private conversationFromRow(row: ConversationRow): Conversation {
    return {
      id: row.id,
      revision: row.revision,
      state: row.state,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private turnFromRow(row: TurnRow): Turn {
    return {
      id: row.id,
      conversationId: row.conversation_id,
      sequence: row.sequence,
      actorPrincipalId: row.actor_principal_id,
      ...(row.actor_transport && row.actor_external_id ? { actorIdentity: { transport: row.actor_transport, externalId: row.actor_external_id } } : {}),
      inputEventId: row.input_event_id,
      ...(row.primary_run_id ? { primaryRunId: row.primary_run_id } : {}),
      content: parseJson<Turn["content"]>(row.content_json),
      ...(row.reply_to_turn_id ? { replyToTurnId: row.reply_to_turn_id } : {}),
      createdAt: row.created_at,
    };
  }

  async createChildRunWithStep(delegation: DelegationRecord, run: Run, firstStep: Step): Promise<void> {
    if (run.parentRunId !== delegation.parentRunId || run.id !== delegation.childRunId) {
      throw new TypeError("delegation lineage must match the Child Run");
    }
    if (run.context.origin.kind !== "delegation" || run.context.origin.parentRunId !== delegation.parentRunId) {
      throw new TypeError("Child Run execution origin must reference its Parent Run");
    }
    this.database.transaction(() => {
      this.insertRunWithStep(run, firstStep);
      this.database.prepare(`
        INSERT INTO delegations(
          id, parent_run_id, child_run_id, idempotency_key, task_json,
          budget_ceiling_json, agent_profile_ref, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        delegation.id,
        delegation.parentRunId,
        delegation.childRunId,
        delegation.idempotencyKey,
        json(delegation.task),
        delegation.budgetCeiling ? json(delegation.budgetCeiling) : null,
        delegation.agentProfileRef ?? null,
        delegation.createdAt,
      );
    })();
  }

  async getDelegation(delegationId: string): Promise<DelegationRecord | undefined> {
    const row = this.database.prepare("SELECT * FROM delegations WHERE id = ?").get(delegationId) as DelegationRow | undefined;
    return row ? this.delegationFromRow(row) : undefined;
  }

  async getDelegationByKey(parentRunId: string, idempotencyKey: string): Promise<DelegationRecord | undefined> {
    const row = this.database.prepare("SELECT * FROM delegations WHERE parent_run_id = ? AND idempotency_key = ?")
      .get(parentRunId, idempotencyKey) as DelegationRow | undefined;
    return row ? this.delegationFromRow(row) : undefined;
  }

  async listChildDelegations(parentRunId: string): Promise<readonly DelegationRecord[]> {
    const rows = this.database.prepare("SELECT * FROM delegations WHERE parent_run_id = ? ORDER BY created_at, id")
      .all(parentRunId) as DelegationRow[];
    return rows.map(row => this.delegationFromRow(row));
  }

  private delegationFromRow(row: DelegationRow): DelegationRecord {
    return {
      id: row.id,
      parentRunId: row.parent_run_id,
      childRunId: row.child_run_id,
      idempotencyKey: row.idempotency_key,
      task: parseJson<DelegationRecord["task"]>(row.task_json),
      ...(row.budget_ceiling_json
        ? { budgetCeiling: parseJson<NonNullable<DelegationRecord["budgetCeiling"]>>(row.budget_ceiling_json) }
        : {}),
      ...(row.agent_profile_ref ? { agentProfileRef: row.agent_profile_ref } : {}),
      createdAt: row.created_at,
    };
  }

  async createRunWithStep(run: Run, firstStep: Step): Promise<void> {
    this.database.transaction(() => this.insertRunWithStep(run, firstStep))();
  }

  private insertRunWithStep(run: Run, firstStep: Step): void {
    if (firstStep.runId !== run.id) throw new TypeError("first step must belong to the new run");
    if (run.revision !== 0 || firstStep.revision !== 0) throw new TypeError("new runs and steps must begin at revision zero");
    if (firstStep.sequence !== 0) throw new TypeError("first step sequence must be zero");
    if (run.state !== "queued" || firstStep.state !== "pending") {
      throw new TypeError("new execution must begin with a queued run and pending step");
    }

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
  }

  async appendStep(step: Step): Promise<void> {
    if (step.revision !== 0 || step.state !== "pending") throw new TypeError("new steps must begin pending at revision zero");
    this.database.transaction(() => {
      const next = this.database.prepare("SELECT COALESCE(MAX(sequence) + 1, 0) AS sequence FROM steps WHERE run_id = ?")
        .get(step.runId) as { sequence: number };
      if (step.sequence !== next.sequence) throw new ExecutionStoreConflictError(`step sequence must be ${next.sequence}`);
      this.database.prepare(`
        INSERT INTO steps(id, run_id, revision, sequence, kind, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(step.id, step.runId, step.revision, step.sequence, step.kind, step.state, step.createdAt, step.updatedAt);
      this.insertAudit("step.created", "step", step.id, step.runId, { kind: step.kind, sequence: step.sequence }, step.createdAt);
    })();
  }

  async recordModelCall(call: ModelCallRecord): Promise<void> {
    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO model_calls(id, run_id, step_id, model, messages_json, response_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(call.id, call.runId, call.stepId, call.model, json(call.messages), json(call.response), call.createdAt);
      this.insertAudit("model_call.completed", "model_call", call.id, call.runId, { stepId: call.stepId, model: call.model }, call.createdAt);
    })();
  }

  async completeRunWithOutput(completion: CompleteRunWithOutput): Promise<void> {
    const { output, delivery } = completion;
    if (delivery.runId !== output.runId || delivery.state !== "pending" || delivery.deliveredAt !== undefined) {
      throw new TypeError("new delivery intent must be pending and belong to the output Run");
    }
    this.database.transaction(() => {
      const runUpdate = this.database.prepare(`
        UPDATE runs
        SET revision = revision + 1, state = 'succeeded', waiting_reason = NULL,
            interruption_json = NULL, resume_eligibility = 'not_applicable', updated_at = ?
        WHERE id = ? AND state = 'running' AND revision = ?
      `).run(completion.runUpdatedAt, output.runId, completion.expectedRunRevision);
      expectOne(runUpdate.changes, `run ${output.runId} changed concurrently`);
      this.database.prepare("INSERT INTO run_outputs(id, run_id, text, usage_json, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(output.id, output.runId, output.text, json(output.usage), output.createdAt);
      this.database.prepare(`
        INSERT INTO delivery_intents(id, run_id, destination_json, payload_json, state, created_at, delivered_at)
        VALUES (?, ?, ?, ?, 'pending', ?, NULL)
      `).run(delivery.id, delivery.runId, json(delivery.destination), json(delivery.payload), delivery.createdAt);
      this.database.prepare("DELETE FROM checkpoints WHERE run_id = ?").run(output.runId);
      this.insertAudit("run.output_recorded", "output", output.id, output.runId, { textLength: output.text.length }, output.createdAt);
      this.insertAudit("delivery.created", "delivery", delivery.id, output.runId, { state: "pending" }, delivery.createdAt);
      this.insertAudit(
        "run.progressed",
        "run",
        output.runId,
        output.runId,
        {
          from: "running",
          to: "succeeded",
          revision: completion.expectedRunRevision + 1,
          checkpointCleared: true,
        },
        completion.runUpdatedAt,
      );
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
          capability, tier, interaction_requirement, resource_json, decided_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        decision.id,
        decision.operationId,
        decision.allow ? 1 : 0,
        decision.reason,
        decision.policyId,
        decision.principalId,
        decision.capability,
        decision.tier,
        decision.interactionRequirement,
        decision.resource ? json(decision.resource) : null,
        decision.decidedAt,
      );
      this.database.prepare(`
        INSERT INTO operations(
          id, step_id, kind, input_json, state, capability, authorization_tier, side_effect,
          idempotency_key, authorization_decision_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        operation.id,
        operation.stepId,
        operation.kind,
        json(operation.input),
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
        ON CONFLICT(operation_id) DO UPDATE SET
          outcome = excluded.outcome,
          effect_status = excluded.effect_status,
          output_json = excluded.output_json,
          error_json = excluded.error_json,
          completed_at = excluded.completed_at
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
    return row ? this.runFromRow(row) : undefined;
  }

  async listRecoverableRuns(): Promise<readonly Run[]> {
    const rows = this.database.prepare(`
      SELECT * FROM runs
      WHERE state IN ('queued', 'running', 'waiting')
        AND resume_eligibility IN ('eligible', 'manual_review')
      ORDER BY created_at, id
    `).all() as RunRow[];
    return rows.map(row => this.runFromRow(row));
  }

  private runFromRow(row: RunRow): Run {
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

  async listSteps(runId: string): Promise<readonly Step[]> {
    const rows = this.database.prepare("SELECT * FROM steps WHERE run_id = ? ORDER BY sequence")
      .all(runId) as StepRow[];
    return rows.map(row => ({
      id: row.id,
      runId: row.run_id,
      revision: row.revision,
      sequence: row.sequence,
      kind: row.kind,
      state: row.state,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async getOperation(operationId: string): Promise<Operation | undefined> {
    const row = this.database.prepare("SELECT * FROM operations WHERE id = ?").get(operationId) as OperationRow | undefined;
    return row ? this.operationFromRow(row) : undefined;
  }

  async listOperations(runId: string): Promise<readonly Operation[]> {
    const rows = this.database.prepare(`
      SELECT operations.*
      FROM operations
      JOIN steps ON steps.id = operations.step_id
      WHERE steps.run_id = ?
      ORDER BY steps.sequence, operations.rowid
    `).all(runId) as OperationRow[];
    return rows.map(row => this.operationFromRow(row));
  }

  async getOperationByIdempotencyKey(kind: string, idempotencyKey: string): Promise<Operation | undefined> {
    const row = this.database.prepare("SELECT * FROM operations WHERE kind = ? AND idempotency_key = ?")
      .get(kind, idempotencyKey) as OperationRow | undefined;
    return row ? this.operationFromRow(row) : undefined;
  }

  private operationFromRow(row: OperationRow): Operation {
    return {
      id: row.id,
      stepId: row.step_id,
      kind: row.kind,
      input: parseJson<JsonObject>(row.input_json),
      state: row.state,
      capability: row.capability,
      authorizationTier: row.authorization_tier,
      sideEffect: row.side_effect,
      ...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : {}),
      authorizationDecisionId: row.authorization_decision_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
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
      interactionRequirement: row.interaction_requirement,
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

  async listModelCalls(runId: string): Promise<readonly ModelCallRecord[]> {
    const rows = this.database.prepare("SELECT * FROM model_calls WHERE run_id = ? ORDER BY rowid").all(runId) as Array<{
      id: string; run_id: string; step_id: string; model: string; messages_json: string; response_json: string; created_at: string;
    }>;
    return rows.map(row => ({
      id: row.id,
      runId: row.run_id,
      stepId: row.step_id,
      model: row.model,
      messages: parseJson<ModelCallRecord["messages"]>(row.messages_json),
      response: parseJson<ModelCallRecord["response"]>(row.response_json),
      createdAt: row.created_at,
    }));
  }

  async getRunOutput(runId: string): Promise<RunOutput | undefined> {
    const row = this.database.prepare("SELECT * FROM run_outputs WHERE run_id = ?").get(runId) as {
      id: string; run_id: string; text: string; usage_json: string; created_at: string;
    } | undefined;
    return row ? {
      id: row.id,
      runId: row.run_id,
      text: row.text,
      usage: parseJson<RunOutput["usage"]>(row.usage_json),
      createdAt: row.created_at,
    } : undefined;
  }

  async getDeliveryIntent(deliveryId: string): Promise<DeliveryIntent | undefined> {
    const row = this.database.prepare("SELECT * FROM delivery_intents WHERE id = ?").get(deliveryId) as {
      id: string; run_id: string; destination_json: string; payload_json: string; state: DeliveryIntent["state"];
      created_at: string; delivered_at: string | null;
    } | undefined;
    return row ? this.deliveryFromRow(row) : undefined;
  }

  async listPendingDeliveries(): Promise<readonly DeliveryIntent[]> {
    const rows = this.database.prepare("SELECT * FROM delivery_intents WHERE state = 'pending' ORDER BY created_at, id").all() as Array<{
      id: string; run_id: string; destination_json: string; payload_json: string; state: DeliveryIntent["state"];
      created_at: string; delivered_at: string | null;
    }>;
    return rows.map(row => this.deliveryFromRow(row));
  }

  async markDeliveryDelivered(deliveryId: string, deliveredAt: string): Promise<void> {
    this.database.transaction(() => {
      const update = this.database.prepare(`
        UPDATE delivery_intents SET state = 'delivered', delivered_at = ?
        WHERE id = ? AND state = 'pending'
      `).run(deliveredAt, deliveryId);
      expectOne(update.changes, `delivery ${deliveryId} changed concurrently`);
      const row = this.database.prepare("SELECT run_id FROM delivery_intents WHERE id = ?").get(deliveryId) as { run_id: string };
      this.insertAudit("delivery.delivered", "delivery", deliveryId, row.run_id, { state: "delivered" }, deliveredAt);
    })();
  }

  private deliveryFromRow(row: {
    id: string; run_id: string; destination_json: string; payload_json: string; state: DeliveryIntent["state"];
    created_at: string; delivered_at: string | null;
  }): DeliveryIntent {
    return {
      id: row.id,
      runId: row.run_id,
      destination: parseJson<DeliveryIntent["destination"]>(row.destination_json),
      payload: parseJson<DeliveryIntent["payload"]>(row.payload_json),
      state: row.state,
      createdAt: row.created_at,
      ...(row.delivered_at ? { deliveredAt: row.delivered_at } : {}),
    };
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
      SELECT ?, ?, ?, ?
      WHERE ? = 1 OR EXISTS (SELECT 1 FROM checkpoints WHERE run_id = ?)
      ON CONFLICT(run_id) DO UPDATE SET
        version = excluded.version,
        data_json = excluded.data_json,
        updated_at = excluded.updated_at
      WHERE excluded.version = checkpoints.version + 1
    `).run(
      checkpoint.runId,
      checkpoint.version,
      json(checkpoint.data),
      checkpoint.updatedAt,
      checkpoint.version,
      checkpoint.runId,
    );
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
