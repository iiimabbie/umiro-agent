import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
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
  type ConversationPreferences,
  type ConversationPreferenceStore,
  type ConversationCompaction,
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
  type SteerInputEventRequest,
  type SteerInputEventResult,
  type PersistedTransportIdentity,
  type SearchHit,
  type SearchDocumentInput,
  type SearchDocumentProjection,
  type VisibilityScope,
  type EmbeddingJob,
  type CreateScheduledTrigger,
  type ScheduledOccurrence,
  type ScheduledTrigger,
  type ConversationHistoryItem,
  type ConversationMessagePage,
  type ConversationSummary,
  type Artifact,
  type ArtifactWorkspaceEntry,
  type ArtifactStore,
  type CreateArtifactRequest,
  type UpdateConversationPreferencesRequest,
  type PendingSteeredInput,
  type InputEvent,
} from "@umiro/core";
import { initializeSchema } from "../schema.js";
import { SQLitePluginStateStore } from "./plugin-state-store.js";

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
  artifact_ids_json: string | null;
  completed_at: string;
}

interface ToolEvidenceRow {
  kind: string;
  input_json: string;
  outcome: OperationResult["outcome"] | null;
  output_json: string | null;
  error_json: string | null;
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

interface ConversationCompactionRow {
  conversation_id: string;
  through_sequence: number;
  source_hash: string;
  summary: string;
  updated_at: string;
}

interface TriggerRow { id: string; revision: number; name: string; enabled: number; schedule_json: string; timezone: string; job_ref: string; input_json: string; creator_principal_id: string; creator_roles_json: string; authority_json: string; destination_json: string | null; misfire_policy: ScheduledTrigger["misfirePolicy"]; max_attempts: number; retry_backoff_ms: number; next_fire_at: string | null; created_at: string; updated_at: string }
interface OccurrenceRow { id: string; trigger_id: string; scheduled_for: string; status: ScheduledOccurrence["status"]; attempts: number; run_id: string; next_retry_at: string | null; error: string | null; claimed_at: string; completed_at: string | null }
interface ArtifactRow { id: string; owner_principal_id: string; visibility: Artifact["visibility"]; media_type: string; filename: string | null; size: number; sha256: string; location: string; extracted_text: string | null; parent_source_json: string | null; state: Artifact["state"]; created_at: string; updated_at: string }
interface ArtifactWorkspaceEntryRow { artifact_id: string; relative_path: string; original_filename: string; state: ArtifactWorkspaceEntry["state"]; device: string | null; inode: string | null; materialized_sha256: string; created_at: string; updated_at: string }

interface DelegationRow {
  id: string;
  parent_run_id: string;
  child_run_id: string;
  idempotency_key: string;
  task_json: string;
  budget_ceiling_json: string | null;
  agent_profile_ref: string | null;
  state: NonNullable<DelegationRecord["state"]>;
  created_at: string;
  updated_at: string | null;
  cancelled_at: string | null;
}

function json(value: JsonValue | object): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("value is not JSON serializable");
  return serialized;
}

function turnText(content: Turn["content"]): string {
  return content.filter((block): block is Extract<Turn["content"][number], { type: "text" }> => block.type === "text").map(block => block.text).join("\n");
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function normalizedExcerpt(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function compactionSummary(
  rows: ReadonlyArray<TurnRow & { assistant_text: string | null }>,
  maxCharacters: number,
): string {
  const maxEntries = Math.max(4, Math.floor(maxCharacters / 240));
  let selected = [...rows];
  if (selected.length > maxEntries) {
    const indexes = new Set<number>([0, selected.length - 1]);
    for (let slot = 1; indexes.size < maxEntries; slot++) {
      indexes.add(Math.round((slot * (selected.length - 1)) / (maxEntries - 1)));
    }
    selected = [...indexes].sort((a, b) => a - b).map(index => rows[index]!);
  }
  const omitted = rows.length - selected.length;
  const overhead = selected.length * 36 + (omitted ? 64 : 0);
  const bodyBudget = Math.max(80, Math.floor((maxCharacters - overhead) / selected.length));
  const lines = selected.map(row => {
    const content = parseJson<Turn["content"]>(row.content_json);
    const user = content.filter(block => block.type === "text").map(block => block.text).join(" ");
    const userBudget = row.assistant_text ? Math.floor(bodyBudget / 2) : bodyBudget;
    const assistantBudget = bodyBudget - userBudget;
    return `[Turn ${row.sequence}] User (${row.actor_principal_id}): ${normalizedExcerpt(user || "[attachment-only message]", userBudget)}${row.assistant_text ? `\nAssistant: ${normalizedExcerpt(row.assistant_text, assistantBudget)}` : ""}`;
  });
  if (omitted) lines.splice(Math.floor(lines.length / 2), 0, `[${omitted} turns omitted by deterministic compaction; canonical history remains searchable]`);
  const summary = lines.join("\n");
  return summary.length <= maxCharacters ? summary : `${summary.slice(0, maxCharacters - 1).trimEnd()}…`;
}

function compactionFromRow(row: ConversationCompactionRow): ConversationCompaction {
  return { conversationId: row.conversation_id, throughSequence: row.through_sequence, sourceHash: row.source_hash, summary: row.summary, updatedAt: row.updated_at };
}

function expectOne(changes: number, message: string): void {
  if (changes !== 1) throw new ExecutionStoreConflictError(message);
}

function searchDocumentVisible(document: VisibilityScope, caller: VisibilityScope): boolean {
  if (caller.kind === "all" || document.kind === "all") return true;
  const principals = new Set(caller.principalIds);
  const labels = new Set(caller.labels);
  const resources = new Set(caller.resources.map(resource => `${resource.kind}:${resource.id}`));
  return document.principalIds.some(id => principals.has(id))
    || document.labels.some(label => labels.has(label))
    || document.resources.some(resource => resources.has(`${resource.kind}:${resource.id}`));
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
    ...(row.extracted_text !== null ? { extractedText: row.extracted_text } : {}),
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.parent_source_json) return { ...artifact, parentSource: parseJson<NonNullable<Artifact["parentSource"]>>(row.parent_source_json) };
  return artifact;
}

function artifactWorkspaceEntryFromRow(row: ArtifactWorkspaceEntryRow): ArtifactWorkspaceEntry {
  return {
    artifactId: row.artifact_id,
    relativePath: row.relative_path,
    originalFilename: row.original_filename,
    state: row.state,
    ...(row.device !== null ? { device: row.device } : {}),
    ...(row.inode !== null ? { inode: row.inode } : {}),
    materializedSha256: row.materialized_sha256,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SQLiteExecutionStore implements ExecutionStore, ConversationStore, ConversationIngressStore, ConversationPreferenceStore, DelegationStore, ArtifactStore, SearchDocumentProjection {
  private readonly database: Database.Database;

  constructor(filename: string) {
    if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
    this.database = new Database(filename);
    sqliteVec.load(this.database);
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("busy_timeout = 5000");
    if (filename !== ":memory:") this.database.pragma("journal_mode = WAL");
    this.database.pragma("synchronous = FULL");
    initializeSchema(this.database);
    this.seedEmbeddingJobs();
  }

  pluginState(namespace: string): SQLitePluginStateStore {
    return new SQLitePluginStateStore(this.database, namespace);
  }

  async getConversationPreferences(transport: string, externalId: string): Promise<ConversationPreferences | undefined> {
    const row = this.database.prepare("SELECT * FROM conversation_preferences WHERE transport=? AND external_id=?").get(transport, externalId) as { transport: string; external_id: string; revision: number; model: string | null; reasoning_effort: ConversationPreferences["reasoningEffort"] | null; queue_mode: ConversationPreferences["queueMode"] | null; updated_at: string } | undefined;
    return row ? { transport: row.transport, externalId: row.external_id, revision: row.revision, ...(row.model ? { model: row.model, reasoningEffort: row.reasoning_effort! } : {}), ...(row.queue_mode ? { queueMode: row.queue_mode } : {}), updatedAt: row.updated_at } : undefined;
  }

  async updateConversationPreferences(request: UpdateConversationPreferencesRequest): Promise<ConversationPreferences> {
    if (!request.transport.trim() || !request.externalId.trim()) throw new TypeError("conversation preference locator must not be empty");
    if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0) throw new TypeError("expected preference revision must be non-negative");
    if ((request.model === undefined) !== (request.reasoningEffort === undefined)) throw new TypeError("model and reasoning effort must be set or reset together");
    if (request.model !== undefined && !request.model.trim()) throw new TypeError("model must not be empty");
    const next: ConversationPreferences = { transport: request.transport, externalId: request.externalId, revision: request.expectedRevision + 1, ...(request.model !== undefined ? { model: request.model.trim(), reasoningEffort: request.reasoningEffort! } : {}), ...(request.queueMode ? { queueMode: request.queueMode } : {}), updatedAt: request.updatedAt };
    this.database.transaction(() => {
      if (request.expectedRevision === 0) {
        const inserted = this.database.prepare(`INSERT OR IGNORE INTO conversation_preferences(transport,external_id,revision,model,reasoning_effort,queue_mode,updated_at) VALUES (?,?,?,?,?,?,?)`)
          .run(next.transport, next.externalId, next.revision, next.model ?? null, next.reasoningEffort ?? null, next.queueMode ?? null, next.updatedAt);
        if (inserted.changes !== 1) throw new ExecutionStoreConflictError(`conversation preferences ${request.transport}:${request.externalId} changed concurrently`);
      } else {
        const updated = this.database.prepare(`UPDATE conversation_preferences SET revision=revision+1, model=?, reasoning_effort=?, queue_mode=?, updated_at=? WHERE transport=? AND external_id=? AND revision=?`)
          .run(next.model ?? null, next.reasoningEffort ?? null, next.queueMode ?? null, next.updatedAt, next.transport, next.externalId, request.expectedRevision);
        expectOne(updated.changes, `conversation preferences ${request.transport}:${request.externalId} changed concurrently`);
      }
    })();
    return next;
  }

  async find(transport: string, externalId: string): Promise<PersistedTransportIdentity | undefined> {
    const row = this.database.prepare("SELECT transport, external_id, principal_id, display_name FROM transport_identities WHERE transport = ? AND external_id = ?")
      .get(transport, externalId) as { transport: string; external_id: string; principal_id: string; display_name: string | null } | undefined;
    return row ? { transport: row.transport, externalId: row.external_id, principalId: row.principal_id, ...(row.display_name ? { displayName: row.display_name } : {}) } : undefined;
  }

  async createArtifact(request: CreateArtifactRequest): Promise<void> {
    const a = request.artifact;
    if (a.size < 0 || !/^[a-f0-9]{64}$/i.test(a.sha256)) throw new TypeError("invalid artifact metadata");
    if (a.extractedText !== undefined && a.extractedText.length > 200_000) throw new TypeError("artifact extracted text exceeds 200000 characters");
    this.database.prepare(`INSERT INTO artifacts(id, owner_principal_id, visibility, media_type, filename, size, sha256, location, extracted_text, parent_source_json, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(a.id, a.ownerPrincipalId, a.visibility, a.mediaType, a.filename ?? null, a.size, a.sha256, a.location, a.extractedText ?? null, a.parentSource ? json(a.parentSource) : null, a.state, a.createdAt, a.updatedAt);
  }

  async createArtifactWithWorkspaceEntry(request: CreateArtifactRequest & { readonly workspaceEntry: ArtifactWorkspaceEntry }): Promise<void> {
    const a = request.artifact;
    const e = request.workspaceEntry;
    if (a.size < 0 || !/^[a-f0-9]{64}$/i.test(a.sha256)) throw new TypeError("invalid artifact metadata");
    if (a.extractedText !== undefined && a.extractedText.length > 200_000) throw new TypeError("artifact extracted text exceeds 200000 characters");
    if (e.artifactId !== a.id || !e.relativePath || !e.originalFilename) throw new TypeError("invalid artifact workspace entry");
    this.database.transaction(() => {
      this.database.prepare(`INSERT INTO artifacts(id, owner_principal_id, visibility, media_type, filename, size, sha256, location, extracted_text, parent_source_json, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(a.id, a.ownerPrincipalId, a.visibility, a.mediaType, a.filename ?? null, a.size, a.sha256, a.location, a.extractedText ?? null, a.parentSource ? json(a.parentSource) : null, a.state, a.createdAt, a.updatedAt);
      this.database.prepare(`INSERT INTO artifact_workspace_entries(artifact_id, relative_path, original_filename, state, device, inode, materialized_sha256, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(e.artifactId, e.relativePath, e.originalFilename, e.state, e.device ?? null, e.inode ?? null, e.materializedSha256, e.createdAt, e.updatedAt);
    })();
  }

  async getArtifactWorkspaceEntry(artifactId: string): Promise<ArtifactWorkspaceEntry | undefined> {
    const row = this.database.prepare("SELECT * FROM artifact_workspace_entries WHERE artifact_id=?").get(artifactId) as ArtifactWorkspaceEntryRow | undefined;
    return row ? artifactWorkspaceEntryFromRow(row) : undefined;
  }

  async getArtifactWorkspaceEntryByPath(relativePath: string): Promise<ArtifactWorkspaceEntry | undefined> {
    const row = this.database.prepare("SELECT * FROM artifact_workspace_entries WHERE relative_path=?").get(relativePath) as ArtifactWorkspaceEntryRow | undefined;
    return row ? artifactWorkspaceEntryFromRow(row) : undefined;
  }

  async listArtifactWorkspaceEntries(): Promise<readonly ArtifactWorkspaceEntry[]> {
    const rows = this.database.prepare("SELECT * FROM artifact_workspace_entries ORDER BY created_at, artifact_id").all() as ArtifactWorkspaceEntryRow[];
    return rows.map(artifactWorkspaceEntryFromRow);
  }

  async updateArtifactWorkspaceLocation(request: { readonly artifactId: string; readonly relativePath: string; readonly filename: string; readonly device?: string; readonly inode?: string; readonly updatedAt: string }): Promise<void> {
    this.database.transaction(() => {
      const updated = this.database.prepare("UPDATE artifact_workspace_entries SET relative_path=?, state='active', device=?, inode=?, updated_at=? WHERE artifact_id=? AND state <> 'trashed'")
        .run(request.relativePath, request.device ?? null, request.inode ?? null, request.updatedAt, request.artifactId);
      expectOne(updated.changes, `artifact workspace entry ${request.artifactId} not found or trashed`);
      const artifact = this.database.prepare("UPDATE artifacts SET filename=?, updated_at=? WHERE id=? AND state <> 'deleted'").run(request.filename, request.updatedAt, request.artifactId);
      expectOne(artifact.changes, `artifact ${request.artifactId} not found or deleted`);
    })();
  }

  async updateArtifactWorkspaceState(artifactId: string, state: ArtifactWorkspaceEntry["state"], updatedAt: string): Promise<void> {
    const result = this.database.prepare("UPDATE artifact_workspace_entries SET state=?, updated_at=? WHERE artifact_id=?").run(state, updatedAt, artifactId);
    expectOne(result.changes, `artifact workspace entry ${artifactId} not found`);
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

  async updateArtifactExtractedText(id: string, text: string, updatedAt: string): Promise<void> {
    if (text.length > 200_000) throw new TypeError("artifact extracted text exceeds 200000 characters");
    const result = this.database.prepare("UPDATE artifacts SET extracted_text=?, updated_at=? WHERE id=? AND state <> 'deleted'").run(text, updatedAt, id);
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

  async hasConversationScope(transport: string, externalId: string): Promise<boolean> {
    const row = this.database.prepare("SELECT 1 AS present FROM conversation_scopes WHERE transport = ? AND external_id = ?")
      .get(transport, externalId) as { present: number } | undefined;
    return row?.present === 1;
  }

  async listConversationScopes(transport?: string): Promise<readonly { readonly transport: string; readonly externalId: string; readonly kind: "direct" | "channel" | "thread" }[]> {
    const rows = (transport
      ? this.database.prepare("SELECT transport, external_id, kind FROM conversation_scopes WHERE transport = ? ORDER BY external_id").all(transport)
      : this.database.prepare("SELECT transport, external_id, kind FROM conversation_scopes ORDER BY transport, external_id").all()
    ) as Array<{ transport: string; external_id: string; kind: "direct" | "channel" | "thread" }>;
    return rows.map(row => ({ transport: row.transport, externalId: row.external_id, kind: row.kind }));
  }

  async getConversationBinding(conversationId: string): Promise<{ readonly transport: string; readonly externalId: string; readonly kind: "direct" | "channel" | "thread" } | undefined> {
    const row = this.database.prepare("SELECT transport, external_id, kind FROM conversation_bindings WHERE conversation_id = ?")
      .get(conversationId) as { transport: string; external_id: string; kind: "direct" | "channel" | "thread" } | undefined;
    return row ? { transport: row.transport, externalId: row.external_id, kind: row.kind } : undefined;
  }

  async listConversationBindings(transport?: string): Promise<readonly { readonly transport: string; readonly externalId: string; readonly kind: "direct" | "channel" | "thread"; readonly conversationId: string }[]> {
    const rows = (transport
      ? this.database.prepare("SELECT transport, external_id, kind, conversation_id FROM conversation_bindings WHERE transport = ? ORDER BY external_id").all(transport)
      : this.database.prepare("SELECT transport, external_id, kind, conversation_id FROM conversation_bindings ORDER BY transport, external_id").all()
    ) as Array<{ transport: string; external_id: string; kind: "direct" | "channel" | "thread"; conversation_id: string }>;
    return rows.map(row => ({ transport: row.transport, externalId: row.external_id, kind: row.kind, conversationId: row.conversation_id }));
  }

  async ingestInputEvent(request: IngestInputEventRequest): Promise<IngestInputEventResult> {
    if (!request.newRunId) throw new TypeError("triggered Turns require a Run ID");
    const newRunId = request.newRunId;
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
      const boundRow = binding
        ? this.database.prepare("SELECT * FROM conversations WHERE id = ?").get(binding.conversation_id) as ConversationRow | undefined
        : undefined;

      if (!binding || !boundRow || boundRow.state !== "active") {
        const conversation: Conversation = {
          id: request.newConversationId,
          revision: 0,
          state: "active",
          createdAt: request.createdAt,
          updatedAt: request.createdAt,
        };
        const initialTurns = request.initialTurns ?? [];
        const replyToTurnId = this.resolveReplyToTurnId(conversation.id, request.event, initialTurns);
        const turn: Turn = {
          id: request.newTurnId,
          conversationId: conversation.id,
          sequence: initialTurns.length,
          actorPrincipalId: request.actorPrincipalId,
          actorIdentity: { transport: request.event.identity.transport, externalId: request.event.identity.externalId },
          inputEventId: request.event.id,
          primaryRunId: newRunId,
          content: structuredClone(request.event.content),
          ...(replyToTurnId ? { replyToTurnId } : {}),
          createdAt: request.createdAt,
        };
        this.database.prepare(`
          INSERT INTO conversations(id, revision, state, created_at, updated_at) VALUES (?, 0, 'active', ?, ?)
        `).run(conversation.id, conversation.createdAt, conversation.updatedAt);
        this.insertConversationLocation(conversation.id, request.event, request.createdAt);
        this.database.prepare(`
          INSERT INTO conversation_bindings(transport, external_id, kind, conversation_id, created_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(transport, external_id) DO UPDATE SET kind=excluded.kind, conversation_id=excluded.conversation_id, created_at=excluded.created_at
        `).run(
          request.event.conversation.transport,
          request.event.conversation.externalId,
          request.event.conversation.kind,
          conversation.id,
          request.createdAt,
        );
        this.database.prepare(`
          INSERT INTO conversation_scopes(transport, external_id, kind, created_at, last_seen_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(transport, external_id) DO UPDATE SET kind=excluded.kind, last_seen_at=excluded.last_seen_at
        `).run(request.event.conversation.transport, request.event.conversation.externalId, request.event.conversation.kind, request.createdAt, request.createdAt);
        for (const [sequence, seed] of initialTurns.entries()) {
          this.insertTurn({ ...seed, conversationId: conversation.id, sequence });
        }
        this.insertTurn(turn);
        return { conversation, turn, duplicate: false, conversationCreated: true };
      }

      const row = boundRow!;
      const next = this.database.prepare("SELECT COALESCE(MAX(sequence) + 1, 0) AS sequence FROM turns WHERE conversation_id = ?")
        .get(row.id) as { sequence: number };
      const replyToTurnId = this.resolveReplyToTurnId(row.id, request.event);
      const turn: Turn = {
        id: request.newTurnId,
        conversationId: row.id,
        sequence: next.sequence,
        actorPrincipalId: request.actorPrincipalId,
        actorIdentity: { transport: request.event.identity.transport, externalId: request.event.identity.externalId },
        inputEventId: request.event.id,
        primaryRunId: newRunId,
        content: structuredClone(request.event.content),
        ...(replyToTurnId ? { replyToTurnId } : {}),
        createdAt: request.createdAt,
      };
      this.insertTurn(turn);
      this.database.prepare("UPDATE conversation_scopes SET kind=?, last_seen_at=? WHERE transport=? AND external_id=?")
        .run(request.event.conversation.kind, request.createdAt, request.event.conversation.transport, request.event.conversation.externalId);
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

  async observeInputEvent(request: IngestInputEventRequest): Promise<IngestInputEventResult | undefined> {
    if (request.newRunId !== undefined) throw new TypeError("observed Turns cannot have a Run");
    return this.database.transaction(() => {
      const duplicate = this.database.prepare("SELECT * FROM turns WHERE input_event_id = ?")
        .get(request.event.id) as TurnRow | undefined;
      if (duplicate) {
        const conversation = this.database.prepare("SELECT * FROM conversations WHERE id = ?")
          .get(duplicate.conversation_id) as ConversationRow | undefined;
        if (!conversation) throw new Error(`Turn ${duplicate.id} references a missing Conversation`);
        return { conversation: this.conversationFromRow(conversation), turn: this.turnFromRow(duplicate), duplicate: true, conversationCreated: false };
      }
      const binding = this.database.prepare("SELECT conversation_id FROM conversation_bindings WHERE transport = ? AND external_id = ?")
        .get(request.event.conversation.transport, request.event.conversation.externalId) as { conversation_id: string } | undefined;
      const boundRow = binding
        ? this.database.prepare("SELECT * FROM conversations WHERE id = ?").get(binding.conversation_id) as ConversationRow | undefined
        : undefined;
      if (!binding || !boundRow || boundRow.state !== "active") {
        const scope = this.database.prepare("SELECT 1 AS present FROM conversation_scopes WHERE transport = ? AND external_id = ?")
          .get(request.event.conversation.transport, request.event.conversation.externalId) as { present: number } | undefined;
        if (!scope) return undefined;
        const conversation: Conversation = { id: request.newConversationId, revision: 0, state: "active", createdAt: request.createdAt, updatedAt: request.createdAt };
        const turn: Turn = { id: request.newTurnId, conversationId: conversation.id, sequence: 0, actorPrincipalId: request.actorPrincipalId, actorIdentity: { transport: request.event.identity.transport, externalId: request.event.identity.externalId }, inputEventId: request.event.id, content: structuredClone(request.event.content), createdAt: request.createdAt };
        this.database.prepare("INSERT INTO conversations(id, revision, state, created_at, updated_at) VALUES (?, 0, 'active', ?, ?)").run(conversation.id, conversation.createdAt, conversation.updatedAt);
        this.insertConversationLocation(conversation.id, request.event, request.createdAt);
        this.database.prepare("INSERT INTO conversation_bindings(transport, external_id, kind, conversation_id, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(transport, external_id) DO UPDATE SET kind=excluded.kind, conversation_id=excluded.conversation_id, created_at=excluded.created_at")
          .run(request.event.conversation.transport, request.event.conversation.externalId, request.event.conversation.kind, conversation.id, request.createdAt);
        this.database.prepare("UPDATE conversation_scopes SET kind=?, last_seen_at=? WHERE transport=? AND external_id=?")
          .run(request.event.conversation.kind, request.createdAt, request.event.conversation.transport, request.event.conversation.externalId);
        this.insertTurn(turn);
        return { conversation, turn, duplicate: false, conversationCreated: true };
      }
      const row = boundRow!;
      const next = this.database.prepare("SELECT COALESCE(MAX(sequence) + 1, 0) AS sequence FROM turns WHERE conversation_id = ?")
        .get(row.id) as { sequence: number };
      const replyToTurnId = this.resolveReplyToTurnId(row.id, request.event);
      const turn: Turn = {
        id: request.newTurnId,
        conversationId: row.id,
        sequence: next.sequence,
        actorPrincipalId: request.actorPrincipalId,
        actorIdentity: { transport: request.event.identity.transport, externalId: request.event.identity.externalId },
        inputEventId: request.event.id,
        content: structuredClone(request.event.content),
        ...(replyToTurnId ? { replyToTurnId } : {}),
        createdAt: request.createdAt,
      };
      this.insertTurn(turn);
      this.database.prepare("UPDATE conversation_scopes SET kind=?, last_seen_at=? WHERE transport=? AND external_id=?")
        .run(request.event.conversation.kind, request.createdAt, request.event.conversation.transport, request.event.conversation.externalId);
      const update = this.database.prepare("UPDATE conversations SET revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND state = 'active'")
        .run(request.createdAt, row.id, row.revision);
      expectOne(update.changes, `conversation ${row.id} changed concurrently`);
      return { conversation: { ...this.conversationFromRow(row), revision: row.revision + 1, updatedAt: request.createdAt }, turn, duplicate: false, conversationCreated: false };
    })();
  }

  async steerInputEvent(request: SteerInputEventRequest): Promise<SteerInputEventResult> {
    return this.database.transaction(() => {
      const existing = this.database.prepare("SELECT * FROM turns WHERE input_event_id=?").get(request.event.id) as TurnRow | undefined;
      if (existing) {
        const conversation = this.database.prepare("SELECT * FROM conversations WHERE id=?").get(existing.conversation_id) as ConversationRow | undefined;
        if (!conversation) throw new Error(`Turn ${existing.id} references a missing Conversation`);
        const queued = this.database.prepare("SELECT 1 FROM run_steered_inputs WHERE id=? AND run_id=?").get(request.event.id, request.runId);
        if (!queued) throw new ExecutionStoreConflictError(`Input Event ${request.event.id} is already attached to another execution`);
        return { conversation: this.conversationFromRow(conversation), turn: this.turnFromRow(existing), duplicate: true };
      }
      const run = this.database.prepare("SELECT state, conversation_id FROM runs WHERE id=?").get(request.runId) as { state: RunState; conversation_id: string | null } | undefined;
      if (!run || run.state !== "running" || !run.conversation_id) throw new ExecutionStoreConflictError(`Run ${request.runId} is not an active conversational Run`);
      const binding = this.database.prepare("SELECT conversation_id FROM conversation_bindings WHERE transport=? AND external_id=?").get(request.event.conversation.transport, request.event.conversation.externalId) as { conversation_id: string } | undefined;
      if (binding?.conversation_id !== run.conversation_id) throw new ExecutionStoreConflictError("steered input conversation differs from the active Run");
      const conversation = this.database.prepare("SELECT * FROM conversations WHERE id=?").get(run.conversation_id) as ConversationRow | undefined;
      if (!conversation || conversation.state !== "active") throw new ExecutionStoreConflictError("steered input conversation is not active");
      const next = this.database.prepare("SELECT COALESCE(MAX(sequence)+1,0) AS sequence FROM turns WHERE conversation_id=?").get(conversation.id) as { sequence: number };
      const replyToTurnId = this.resolveReplyToTurnId(conversation.id, request.event);
      const turn: Turn = { id: request.newTurnId, conversationId: conversation.id, sequence: next.sequence, actorPrincipalId: request.actorPrincipalId, actorIdentity: { transport: request.event.identity.transport, externalId: request.event.identity.externalId }, inputEventId: request.event.id, content: structuredClone(request.event.content), ...(replyToTurnId ? { replyToTurnId } : {}), createdAt: request.createdAt };
      this.insertTurn(turn);
      expectOne(this.database.prepare("UPDATE conversations SET revision=revision+1, updated_at=? WHERE id=? AND revision=? AND state='active'").run(request.createdAt, conversation.id, conversation.revision).changes, `conversation ${conversation.id} changed concurrently`);
      this.database.prepare("INSERT INTO run_steered_inputs(id,run_id,turn_id,content_json,authority_json,actor_roles_json,state,created_at) VALUES (?,?,?,?,?,?, 'pending', ?)").run(request.event.id, request.runId, turn.id, json(request.modelContent), json(request.authority), json(request.actorRoles), request.createdAt);
      return { conversation: { ...this.conversationFromRow(conversation), revision: conversation.revision + 1, updatedAt: request.createdAt }, turn, duplicate: false };
    })();
  }

  async listPendingSteeredInputs(runId: string): Promise<readonly PendingSteeredInput[]> {
    const rows = this.database.prepare("SELECT id,run_id,turn_id,content_json,authority_json,actor_roles_json,created_at FROM run_steered_inputs WHERE run_id=? AND state='pending' ORDER BY created_at,id").all(runId) as Array<{ id: string; run_id: string; turn_id: string; content_json: string; authority_json: string; actor_roles_json: string; created_at: string }>;
    return rows.map(row => ({ id: row.id, runId: row.run_id, turnId: row.turn_id, content: parseJson<PendingSteeredInput["content"]>(row.content_json), authority: parseJson<PendingSteeredInput["authority"]>(row.authority_json), actorRoles: parseJson<PendingSteeredInput["actorRoles"]>(row.actor_roles_json), createdAt: row.created_at }));
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
    this.database.transaction(() => {
      const update = this.database.prepare(`
        UPDATE conversations SET revision = revision + 1, state = ?, updated_at = ?
        WHERE id = ? AND revision = ? AND state = ?
      `).run(request.state, request.updatedAt, request.conversationId, request.expectedRevision, request.expectedState);
      expectOne(update.changes, `conversation ${request.conversationId} changed concurrently`);
    })();
  }

  async archiveBoundConversation(transport: string, externalId: string, archivedAt: string): Promise<Conversation | undefined> {
    return this.database.transaction(() => {
      const row = this.database.prepare("SELECT c.* FROM conversations c JOIN conversation_bindings b ON b.conversation_id = c.id WHERE b.transport = ? AND b.external_id = ?").get(transport, externalId) as ConversationRow | undefined;
      if (!row) return undefined;
      if (row.state !== "active") throw new ExecutionStoreConflictError(`conversation ${row.id} is not active`);
      const update = this.database.prepare("UPDATE conversations SET revision = revision + 1, state = 'archived', updated_at = ? WHERE id = ? AND revision = ? AND state = 'active'").run(archivedAt, row.id, row.revision);
      expectOne(update.changes, `conversation ${row.id} changed concurrently`);
      return { ...this.conversationFromRow(row), revision: row.revision + 1, state: "archived" as const, updatedAt: archivedAt };
    })();
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

  async getHistoryItem(turnId: string): Promise<ConversationHistoryItem | undefined> {
    const row = this.database.prepare("SELECT t.*, o.text AS assistant_text, o.created_at AS assistant_created_at, i.display_name AS actor_display_name FROM turns t LEFT JOIN run_outputs o ON o.run_id=t.primary_run_id LEFT JOIN transport_identities i ON i.transport=t.actor_transport AND i.external_id=t.actor_external_id WHERE t.id=?")
      .get(turnId) as (TurnRow & { assistant_text: string | null; assistant_created_at: string | null; actor_display_name: string | null }) | undefined;
    if (!row) return undefined;
    const toolEvidence = row.primary_run_id ? this.toolEvidenceForRun(row.primary_run_id) : "";
    return { turn: this.turnFromRow(row), ...(row.actor_display_name ? { actorDisplayName: row.actor_display_name } : {}), ...(row.assistant_text ? { assistantText: row.assistant_text } : {}), ...(row.assistant_created_at ? { assistantCreatedAt: row.assistant_created_at } : {}), ...(toolEvidence ? { toolEvidence } : {}) };
  }

  async listTurns(conversationId: string, limit?: number): Promise<readonly Turn[]> {
    const rows = (limit === undefined
      ? this.database.prepare("SELECT * FROM turns WHERE conversation_id = ? ORDER BY sequence").all(conversationId)
      : this.database.prepare("SELECT * FROM (SELECT * FROM turns WHERE conversation_id = ? ORDER BY sequence DESC LIMIT ?) ORDER BY sequence").all(conversationId, limit)) as TurnRow[];
    return rows.map(row => this.turnFromRow(row));
  }

  async listConversations(filter: { readonly transport?: string; readonly externalId?: string; readonly state?: Conversation["state"]; readonly limit?: number } = {}): Promise<readonly ConversationSummary[]> {
    const limit = filter.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new TypeError("conversation list limit must be between 1 and 200");
    if ((filter.transport === undefined) !== (filter.externalId === undefined)) throw new TypeError("conversation scope requires both transport and externalId");
    if (filter.state !== undefined && filter.state !== "active" && filter.state !== "archived") throw new TypeError("conversation state must be active or archived");
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    if (filter.transport !== undefined && filter.externalId !== undefined) { clauses.push("l.transport=? AND l.external_id=?"); parameters.push(filter.transport, filter.externalId); }
    if (filter.state !== undefined) { clauses.push("c.state=?"); parameters.push(filter.state); }
    parameters.push(limit);
    const rows = this.database.prepare(`
      SELECT c.*, l.transport, l.external_id, l.kind,
        COALESCE(MAX(t.created_at), c.created_at) AS last_activity_at,
        COUNT(t.id) AS turn_count
      FROM conversations c
      JOIN conversation_locations l ON l.conversation_id=c.id
      LEFT JOIN turns t ON t.conversation_id=c.id
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      GROUP BY c.id, l.transport, l.external_id, l.kind
      ORDER BY last_activity_at DESC, c.id DESC
      LIMIT ?
    `).all(...parameters) as Array<ConversationRow & { transport: string; external_id: string; kind: "direct" | "channel" | "thread"; last_activity_at: string; turn_count: number }>;
    const textRows = this.database.prepare("SELECT content_json FROM turns WHERE conversation_id=? ORDER BY sequence") as Database.Statement<[string]>;
    return rows.map(row => {
      let firstText: string | undefined;
      for (const candidate of textRows.all(row.id) as Array<{ content_json: string }>) {
        const text = turnText(parseJson<Turn["content"]>(candidate.content_json)).trim();
        if (!text || text.startsWith("[System] This is the initial message")) continue;
        firstText = text.slice(0, 80);
        break;
      }
      return {
        conversation: this.conversationFromRow(row),
        location: { transport: row.transport, externalId: row.external_id, kind: row.kind },
        lastActivityAt: row.last_activity_at,
        turnCount: row.turn_count,
        ...(firstText ? { firstText } : {}),
      };
    });
  }

  async listConversationMessages(conversationId: string, limit = 200, after?: number): Promise<ConversationMessagePage | undefined> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new TypeError("conversation message limit must be between 1 and 500");
    if (after !== undefined && (!Number.isSafeInteger(after) || after < 0)) throw new TypeError("conversation message after must be a non-negative integer");
    const conversationRow = this.database.prepare("SELECT * FROM conversations WHERE id=?").get(conversationId) as ConversationRow | undefined;
    if (!conversationRow) return undefined;
    const location = this.database.prepare("SELECT transport,external_id,kind FROM conversation_locations WHERE conversation_id=?").get(conversationId) as { transport: string; external_id: string; kind: "direct" | "channel" | "thread" } | undefined;
    if (!location) return undefined;
    const parameters = after === undefined ? [conversationId, limit + 1] : [conversationId, after, limit + 1];
    const rows = this.database.prepare(`
      SELECT t.*, i.display_name AS actor_display_name,
        r.id AS reply_run_id, r.state AS reply_state, r.updated_at AS reply_updated_at,
        o.text AS assistant_text, o.usage_json AS usage_json, o.created_at AS assistant_created_at
      FROM turns t
      LEFT JOIN transport_identities i ON i.transport=t.actor_transport AND i.external_id=t.actor_external_id
      LEFT JOIN runs r ON r.id=t.primary_run_id
      LEFT JOIN run_outputs o ON o.run_id=t.primary_run_id
      WHERE t.conversation_id=? ${after === undefined ? "" : "AND t.sequence>?"}
      ORDER BY t.sequence
      LIMIT ?
    `).all(...parameters) as Array<TurnRow & { actor_display_name: string | null; reply_run_id: string | null; reply_state: RunState | null; reply_updated_at: string | null; assistant_text: string | null; usage_json: string | null; assistant_created_at: string | null }>;
    const hasMore = rows.length > limit;
    return {
      conversation: this.conversationFromRow(conversationRow),
      location: { transport: location.transport, externalId: location.external_id, kind: location.kind },
      messages: rows.slice(0, limit).map(row => {
        const reply = row.reply_run_id && row.reply_state && row.reply_updated_at ? {
          runId: row.reply_run_id,
          state: row.reply_state,
          at: row.assistant_created_at ?? row.reply_updated_at,
          ...(row.reply_state === "succeeded" && row.assistant_text !== null ? { text: row.assistant_text } : {}),
          ...(row.usage_json !== null ? { usage: parseJson<NonNullable<NonNullable<ConversationMessagePage["messages"][number]["reply"]>["usage"]>>(row.usage_json) } : {}),
        } : undefined;
        return { turn: this.turnFromRow(row), ...(row.actor_display_name ? { actorDisplayName: row.actor_display_name } : {}), ...(reply ? { reply } : {}) };
      }),
      hasMore,
    };
  }

  async listRecentHistory(conversationId: string, beforeSequence: number, limit: number): Promise<readonly ConversationHistoryItem[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError("history limit must be between 1 and 100");
    const rows = this.database.prepare(`SELECT t.*, o.text AS assistant_text, o.created_at AS assistant_created_at, i.display_name AS actor_display_name FROM turns t LEFT JOIN run_outputs o ON o.run_id = t.primary_run_id LEFT JOIN transport_identities i ON i.transport=t.actor_transport AND i.external_id=t.actor_external_id
      WHERE t.conversation_id = ? AND t.sequence < ? ORDER BY t.sequence DESC LIMIT ?`).all(conversationId, beforeSequence, limit) as Array<TurnRow & { assistant_text: string | null; assistant_created_at: string | null; actor_display_name: string | null }>;
    return rows.reverse().map(row => {
      const toolEvidence = row.primary_run_id ? this.toolEvidenceForRun(row.primary_run_id) : "";
      return { turn: this.turnFromRow(row), ...(row.actor_display_name ? { actorDisplayName: row.actor_display_name } : {}), ...(row.assistant_text ? { assistantText: row.assistant_text } : {}), ...(row.assistant_created_at ? { assistantCreatedAt: row.assistant_created_at } : {}), ...(toolEvidence ? { toolEvidence } : {}) };
    });
  }

  async refreshConversationCompaction(request: { readonly conversationId: string; readonly beforeSequence: number; readonly retainRecent: number; readonly maxCharacters: number; readonly updatedAt: string }): Promise<ConversationCompaction | undefined> {
    if (!Number.isSafeInteger(request.beforeSequence) || request.beforeSequence < 0) throw new TypeError("beforeSequence must be a non-negative integer");
    if (!Number.isSafeInteger(request.retainRecent) || request.retainRecent < 1 || request.retainRecent > 100) throw new TypeError("retainRecent must be between 1 and 100");
    if (!Number.isSafeInteger(request.maxCharacters) || request.maxCharacters < 500 || request.maxCharacters > 100_000) throw new TypeError("compaction maxCharacters must be between 500 and 100000");
    const throughSequence = request.beforeSequence - request.retainRecent - 1;
    if (throughSequence < 0) return undefined;
    const rows = this.database.prepare(`SELECT t.*, o.text AS assistant_text FROM turns t LEFT JOIN run_outputs o ON o.run_id=t.primary_run_id
      WHERE t.conversation_id=? AND t.sequence<=? ORDER BY t.sequence`).all(request.conversationId, throughSequence) as Array<TurnRow & { assistant_text: string | null }>;
    if (!rows.length) return undefined;
    const sourceHash = createHash("sha256");
    for (const row of rows) sourceHash.update(json([row.id, row.sequence, row.actor_principal_id, row.content_json, row.assistant_text]));
    const digest = sourceHash.digest("hex");
    const existing = this.database.prepare("SELECT * FROM conversation_compactions WHERE conversation_id=?").get(request.conversationId) as ConversationCompactionRow | undefined;
    if (existing?.through_sequence === throughSequence && existing.source_hash === digest && existing.summary.length <= request.maxCharacters) return compactionFromRow(existing);
    const summary = compactionSummary(rows, request.maxCharacters);
    this.database.prepare(`INSERT INTO conversation_compactions(conversation_id, through_sequence, source_hash, summary, updated_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(conversation_id) DO UPDATE SET through_sequence=excluded.through_sequence, source_hash=excluded.source_hash, summary=excluded.summary, updated_at=excluded.updated_at`)
      .run(request.conversationId, throughSequence, digest, summary, request.updatedAt);
    return { conversationId: request.conversationId, throughSequence, sourceHash: digest, summary, updatedAt: request.updatedAt };
  }

  /** Resolve a transport reply to a canonical Turn in the same Conversation.
   * Adapter event IDs use `<transport>:<external message id>` while synthetic
   * thread starters use `<transport>:starter:<external message id>`. Delivery
   * evidence also maps replies to the bot's messages back to their source Turn. */
  private resolveReplyToTurnId(conversationId: string, event: InputEvent, initialTurns: readonly { readonly id: string; readonly inputEventId: string }[] = []): string | undefined {
    const externalId = event.replyToExternalId;
    if (!externalId) return undefined;
    const candidates = [`${event.conversation.transport}:${externalId}`, `${event.conversation.transport}:starter:${externalId}`];
    const seeded = initialTurns.find(turn => candidates.includes(turn.inputEventId));
    if (seeded) return seeded.id;
    const placeholders = candidates.map(() => "?").join(",");
    const turn = this.database.prepare(`SELECT id FROM turns WHERE conversation_id=? AND input_event_id IN (${placeholders}) ORDER BY sequence DESC LIMIT 1`)
      .get(conversationId, ...candidates) as { id: string } | undefined;
    if (turn) return turn.id;
    const delivery = this.database.prepare(`SELECT r.turn_id AS turnId FROM delivery_intents d JOIN runs r ON r.id=d.run_id WHERE r.conversation_id=? AND d.state='delivered' AND json_extract(d.delivery_evidence_json, '$.transport')=? AND json_extract(d.delivery_evidence_json, '$.messageId')=? ORDER BY d.delivered_at DESC LIMIT 1`)
      .get(conversationId, event.conversation.transport, externalId) as { turnId: string | null } | undefined;
    return delivery?.turnId ?? undefined;
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
    const text = this.turnProjectionText(turn.content, turn.primaryRunId);
    if (text.trim()) this.database.prepare("INSERT INTO conversation_fts(turn_id, conversation_id, actor_principal_id, text) VALUES (?, ?, ?, ?)")
      .run(turn.id, turn.conversationId, turn.actorPrincipalId, text);
    if (text.trim()) this.enqueueEmbedding(`turn:${turn.id}`, text);
  }

  private insertConversationLocation(conversationId: string, event: InputEvent, createdAt: string): void {
    this.database.prepare("INSERT INTO conversation_locations(conversation_id,transport,external_id,kind,created_at) VALUES (?,?,?,?,?)")
      .run(conversationId, event.conversation.transport, event.conversation.externalId, event.conversation.kind, createdAt);
  }

  private attachmentEvidence(content: Turn["content"]): string {
    const ids = [...new Set(content.filter(block => block.type === "artifact_reference").map(block => block.artifactId))].slice(0, 20);
    const rendered = ids.flatMap(id => {
      const artifact = this.database.prepare("SELECT id, filename, media_type, size, extracted_text FROM artifacts WHERE id=? AND state <> 'deleted'").get(id) as { id: string; filename: string | null; media_type: string; size: number; extracted_text: string | null } | undefined;
      if (!artifact) return [];
      const text = artifact.extracted_text?.trim() ?? "";
      const excerpt = text.length > 6_000 ? `${text.slice(0, 4_500)}\n… attachment text truncated …\n${text.slice(-1_500)}` : text;
      return [`Attachment: ${artifact.filename ?? artifact.id}\nMedia type: ${artifact.media_type}\nSize: ${artifact.size} bytes${excerpt ? `\nExtracted text:\n${excerpt}` : ""}`];
    }).join("\n\n");
    return rendered.length > 24_000 ? `${rendered.slice(0, 16_000)}\n… attachment evidence truncated …\n${rendered.slice(-8_000)}` : rendered;
  }

  private turnProjectionText(content: Turn["content"], runId?: string | null, assistantText = ""): string {
    const input = content.filter(block => block.type === "text").map(block => block.text).join("\n").trim();
    const attachments = this.attachmentEvidence(content);
    const tools = runId ? this.toolEvidenceForRun(runId) : "";
    return [input, attachments, assistantText.trim(), tools].filter(Boolean).join("\n\n");
  }

  /**
   * Search gets a bounded evidence projection, never the canonical operation payload.
   * Tool inputs/results can contain credentials or arbitrary external text, so redact
   * sensitive keys and common bearer/key-shaped strings before truncating the summary.
   */
  private toolEvidenceForRun(runId: string): string {
    const rows = this.database.prepare(`
      SELECT o.kind, o.input_json, r.outcome, r.output_json, r.error_json
      FROM operations o
      JOIN steps s ON s.id=o.step_id
      LEFT JOIN operation_results r ON r.operation_id=o.id
      WHERE s.run_id=? ORDER BY s.sequence DESC, o.created_at DESC, o.id DESC LIMIT 20
    `).all(runId) as ToolEvidenceRow[];
    const rendered = rows.reverse().map(row => {
      const input = this.safeEvidenceJson(row.input_json);
      const output = row.output_json ? this.safeEvidenceJson(row.output_json) : row.error_json ? this.safeEvidenceJson(row.error_json) : "(no result)";
      return `Tool: ${row.kind}\nOutcome: ${row.outcome ?? "pending"}\nArguments: ${input}\nResult: ${output}`;
    }).join("\n\n");
    return rendered.length > 12_000 ? `${rendered.slice(0, 8_000)}\n… tool evidence truncated …\n${rendered.slice(-4_000)}` : rendered;
  }

  private safeEvidenceJson(serialized: string): string {
    let value: unknown;
    try { value = JSON.parse(serialized) as unknown; } catch { value = serialized; }
    const redact = (current: unknown, key?: string, depth = 0): unknown => {
      if (key && /(?:authorization|api[_-]?key|credential|cookie|password|secret|token)/i.test(key)) return "[REDACTED]";
      if (typeof current === "string") return current
        .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
        .replace(/\b(?:sk|rk|xox[baprs]|gh[pousr])-[A-Za-z0-9_-]{8,}\b/gi, "[REDACTED]")
        .slice(0, 600);
      if (depth >= 6 && current !== null && typeof current === "object") return "[TRUNCATED]";
      if (Array.isArray(current)) return current.slice(0, 40).map(item => redact(item, undefined, depth + 1));
      if (current !== null && typeof current === "object") return Object.fromEntries(Object.entries(current).slice(0, 40).map(([name, item]) => [name, redact(item, name, depth + 1)]));
      return current;
    };
    const rendered = JSON.stringify(redact(value));
    if (!rendered) return "(empty)";
    const compact = rendered.replace(/\s+/g, " ").trim();
    return compact.length > 1_200 ? `${compact.slice(0, 900)} … ${compact.slice(-300)}` : compact;
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
  async updateScheduledTrigger(id: string, patch: { readonly name: string; readonly schedule: ScheduledTrigger["schedule"]; readonly timezone: string; readonly input: JsonObject; readonly destination?: JsonObject; readonly misfirePolicy: ScheduledTrigger["misfirePolicy"]; readonly maxAttempts: number; readonly retryBackoffMs: number }, expectedRevision: number, nextFireAt: string | null, updatedAt: string): Promise<ScheduledTrigger> {
    const result = this.database.prepare(`UPDATE scheduled_triggers SET name=?, schedule_json=?, timezone=?, input_json=?, destination_json=?, misfire_policy=?, max_attempts=?, retry_backoff_ms=?, next_fire_at=?, revision=revision+1, updated_at=? WHERE id=? AND revision=?`).run(patch.name, json(patch.schedule), patch.timezone, json(patch.input), patch.destination ? json(patch.destination) : null, patch.misfirePolicy, patch.maxAttempts, patch.retryBackoffMs, nextFireAt, updatedAt, id, expectedRevision);
    expectOne(result.changes, `scheduled trigger changed: ${id}`); return (await this.getScheduledTrigger(id))!;
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

  private vectorBlob(vector: readonly number[]): Buffer {
    return Buffer.from(new Float32Array(vector).buffer);
  }

  private ensureVectorIndex(model: string, dimensions: number): void {
    const existing = this.database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='search_embeddings_vec'").get() as { sql: string } | undefined;
    const configuredDimensions = existing?.sql.match(/embedding\s+float\[(\d+)\]/i)?.[1];
    if (existing && Number(configuredDimensions) !== dimensions) {
      this.database.exec("DROP TABLE search_embeddings_vec");
      this.database.prepare("DELETE FROM search_embeddings").run();
    }
    if (!existing || Number(configuredDimensions) !== dimensions) {
      if (!Number.isSafeInteger(dimensions) || dimensions < 1 || dimensions > 65_536) throw new TypeError("embedding dimensions are invalid");
      this.database.exec(`CREATE VIRTUAL TABLE search_embeddings_vec USING vec0(document_key TEXT PRIMARY KEY, embedding float[${dimensions}] distance_metric=cosine)`);
      const rows = this.database.prepare("SELECT document_key, vector_json FROM search_embeddings WHERE model=? AND dimensions=?").all(model, dimensions) as Array<{ document_key: string; vector_json: string }>;
      const insert = this.database.prepare("INSERT INTO search_embeddings_vec(document_key, embedding) VALUES (?, ?)");
      for (const row of rows) insert.run(row.document_key, this.vectorBlob(parseJson<number[]>(row.vector_json)));
    }
  }

  private enqueueEmbedding(documentKey: string, text: string): void {
    const hash = this.contentHash(text);
    const existing = this.database.prepare("SELECT content_hash FROM search_embeddings WHERE document_key = ?").get(documentKey) as { content_hash: string } | undefined;
    if (existing?.content_hash === hash) return;
    this.database.prepare(`INSERT INTO search_embedding_jobs(document_key, content_hash, status, attempts, next_retry_at, last_error, updated_at)
      VALUES (?, ?, 'pending', 0, NULL, NULL, ?)
      ON CONFLICT(document_key) DO UPDATE SET content_hash=excluded.content_hash, status='pending', attempts=0, next_retry_at=NULL, last_error=NULL, updated_at=excluded.updated_at`)
      .run(documentKey, hash, new Date().toISOString());
  }

  private removeEmbedding(documentKey: string): void {
    if (this.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='search_embeddings_vec'").get()) {
      this.database.prepare("DELETE FROM search_embeddings_vec WHERE document_key=?").run(documentKey);
    }
    this.database.prepare("DELETE FROM search_embedding_jobs WHERE document_key=?").run(documentKey);
    this.database.prepare("DELETE FROM search_embeddings WHERE document_key=?").run(documentKey);
  }

  private refreshTurnSearchProjection(runId: string): void {
    const row = this.database.prepare("SELECT t.id, t.conversation_id, t.actor_principal_id, t.content_json, o.text AS assistant_text FROM turns t LEFT JOIN run_outputs o ON o.run_id=t.primary_run_id WHERE t.primary_run_id=?").get(runId) as { id: string; conversation_id: string; actor_principal_id: string; content_json: string; assistant_text: string | null } | undefined;
    if (!row) return;
    const content = parseJson<Turn["content"]>(row.content_json);
    const text = this.turnProjectionText(content, runId, row.assistant_text ?? "");
    if (!text.trim()) return;
    this.database.prepare("DELETE FROM conversation_fts WHERE turn_id = ?").run(row.id);
    this.database.prepare("INSERT INTO conversation_fts(turn_id, conversation_id, actor_principal_id, text) VALUES (?, ?, ?, ?)").run(row.id, row.conversation_id, row.actor_principal_id, text);
    this.enqueueEmbedding(`turn:${row.id}`, text);
  }

  private refreshChildRunSearchProjection(runId: string): void {
    const row = this.database.prepare(`SELECT child.id AS child_run_id,child.parent_run_id,parent.conversation_id,parent.context_json,o.text,o.created_at
      FROM runs child JOIN runs parent ON parent.id=child.parent_run_id JOIN run_outputs o ON o.run_id=child.id
      WHERE child.id=?`).get(runId) as { child_run_id: string; parent_run_id: string; conversation_id: string | null; context_json: string; text: string; created_at: string } | undefined;
    if (!row?.text.trim()) return;
    const parentContext = parseJson<ExecutionContext>(row.context_json);
    const documentKey = `document:core:${row.child_run_id}`;
    this.removeEmbedding(documentKey);
    this.database.prepare("DELETE FROM search_documents_fts WHERE namespace='core' AND document_id=?").run(row.child_run_id);
    this.database.prepare("DELETE FROM search_documents WHERE namespace='core' AND document_id=?").run(row.child_run_id);
    this.database.prepare(`INSERT INTO search_documents(namespace,source_id,document_id,source_type,text,visibility_json,occurred_at,conversation_id,actor_principal_id)
      VALUES ('core',?,?,?,?,?,?,?,?)`).run(row.child_run_id, row.child_run_id, "child_run_output", row.text, json(parentContext.authority.visibility), row.created_at, row.conversation_id, parentContext.actor.id);
    this.database.prepare("INSERT INTO search_documents_fts(namespace,document_id,source_type,source_id,text) VALUES ('core',?,?,?,?)")
      .run(row.child_run_id, "child_run_output", row.child_run_id, row.text);
    this.enqueueEmbedding(documentKey, row.text);
  }

  private seedEmbeddingJobs(): void {
    const rows = this.database.prepare(`SELECT t.id, t.content_json, t.primary_run_id, o.text AS assistant_text FROM turns t LEFT JOIN run_outputs o ON o.run_id=t.primary_run_id LEFT JOIN search_embeddings e ON e.document_key='turn:' || t.id WHERE e.document_key IS NULL`).all() as Array<{ id: string; content_json: string; primary_run_id: string | null; assistant_text: string | null }>;
    for (const row of rows) {
      const content = parseJson<Turn["content"]>(row.content_json);
      const text = this.turnProjectionText(content, row.primary_run_id, row.assistant_text ?? "");
      if (text.trim()) this.enqueueEmbedding(`turn:${row.id}`, text);
    }
    const documents = this.database.prepare(`SELECT d.namespace,d.document_id,d.text FROM search_documents d LEFT JOIN search_embeddings e ON e.document_key='document:' || d.namespace || ':' || d.document_id WHERE e.document_key IS NULL`).all() as Array<{ namespace: string; document_id: string; text: string }>;
    for (const document of documents) this.enqueueEmbedding(`document:${document.namespace}:${document.document_id}`, document.text);
  }

  private embeddingSource(documentKey: string): { readonly text: string; readonly hit: SearchHit; readonly visibility?: VisibilityScope; readonly occurredAt: string } | undefined {
    const turn = this.database.prepare(`SELECT t.id,t.conversation_id,t.actor_principal_id,t.content_json,t.primary_run_id,t.created_at,o.text AS assistant_text
      FROM turns t LEFT JOIN run_outputs o ON o.run_id=t.primary_run_id WHERE 'turn:' || t.id=?`).get(documentKey) as { id: string; conversation_id: string; actor_principal_id: string; content_json: string; primary_run_id: string | null; created_at: string; assistant_text: string | null } | undefined;
    if (turn) {
      const text = this.turnProjectionText(parseJson<Turn["content"]>(turn.content_json), turn.primary_run_id, turn.assistant_text ?? "");
      return { text, occurredAt: turn.created_at, hit: { turnId: turn.id, conversationId: turn.conversation_id, actorPrincipalId: turn.actor_principal_id, text, rank: 0 } };
    }
    const document = this.database.prepare(`SELECT namespace,document_id,source_type,source_id,text,visibility_json,occurred_at,conversation_id,actor_principal_id
      FROM search_documents WHERE 'document:' || namespace || ':' || document_id=?`).get(documentKey) as { namespace: string; document_id: string; source_type: string; source_id: string; text: string; visibility_json: string; occurred_at: string | null; conversation_id: string | null; actor_principal_id: string | null } | undefined;
    if (!document) return undefined;
    return {
      text: document.text,
      occurredAt: document.occurred_at ?? "",
      visibility: parseJson<VisibilityScope>(document.visibility_json),
      hit: {
        turnId: `document:${document.namespace}:${document.document_id}`,
        conversationId: document.conversation_id ?? `source:${document.source_type}:${document.source_id}`,
        actorPrincipalId: document.actor_principal_id ?? `namespace:${document.namespace}`,
        text: document.text,
        rank: 0,
        documentId: document.document_id,
        sourceType: document.source_type,
        sourceId: document.source_id,
      },
    };
  }

  async prepareEmbeddingModel(model: string): Promise<void> {
    if (!model.trim()) throw new TypeError("embedding model is required");
    this.database.transaction(() => {
      const incompatible = this.database.prepare("SELECT 1 FROM search_embeddings WHERE model <> ? LIMIT 1").get(model);
      if (!incompatible) return;
      this.database.prepare("DELETE FROM search_embeddings").run();
      if (this.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='search_embeddings_vec'").get()) this.database.exec("DROP TABLE search_embeddings_vec");
      this.database.prepare("DELETE FROM search_embedding_jobs").run();
      this.seedEmbeddingJobs();
    })();
  }

  async claimEmbeddingJobs(limit: number, now: string, staleBefore: string): Promise<readonly EmbeddingJob[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError("embedding claim limit must be between 1 and 100");
    return this.database.transaction(() => {
      const rows = this.database.prepare(`SELECT j.document_key, j.content_hash, j.attempts
        FROM search_embedding_jobs j
        WHERE (j.status='pending' OR (j.status='failed' AND (j.next_retry_at IS NULL OR j.next_retry_at <= ?)) OR (j.status='processing' AND j.updated_at < ?))
      ORDER BY j.updated_at, j.document_key LIMIT ?`).all(now, staleBefore, limit) as Array<{ document_key: string; content_hash: string; attempts: number }>;
      const update = this.database.prepare("UPDATE search_embedding_jobs SET status='processing', attempts=attempts+1, updated_at=? WHERE document_key=? AND content_hash=?");
      return rows.flatMap(row => {
        const source = this.embeddingSource(row.document_key);
        if (!source || this.contentHash(source.text) !== row.content_hash) {
          this.database.prepare("DELETE FROM search_embedding_jobs WHERE document_key=?").run(row.document_key);
          return [];
        }
        if (update.run(now, row.document_key, row.content_hash).changes !== 1) return [];
        return [{ documentKey: row.document_key, text: source.text, contentHash: row.content_hash, attempts: row.attempts + 1 }];
      });
    })();
  }

  async completeEmbeddingJob(documentKey: string, contentHash: string, model: string, vector: readonly number[], now: string): Promise<void> {
    if (!vector.length || vector.some(value => !Number.isFinite(value))) throw new TypeError("embedding vector must contain finite values");
    this.database.transaction(() => {
      const job = this.database.prepare("SELECT content_hash FROM search_embedding_jobs WHERE document_key=? AND status='processing'").get(documentKey) as { content_hash: string } | undefined;
      if (job?.content_hash !== contentHash) throw new ExecutionStoreConflictError(`embedding job changed: ${documentKey}`);
      this.database.prepare(`INSERT INTO search_embeddings(document_key, content_hash, model, dimensions, vector_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(document_key) DO UPDATE SET content_hash=excluded.content_hash, model=excluded.model, dimensions=excluded.dimensions, vector_json=excluded.vector_json, updated_at=excluded.updated_at`)
        .run(documentKey, contentHash, model, vector.length, json([...vector]), now);
      this.ensureVectorIndex(model, vector.length);
      this.database.prepare("DELETE FROM search_embeddings_vec WHERE document_key=?").run(documentKey);
      this.database.prepare("INSERT INTO search_embeddings_vec(document_key, embedding) VALUES (?, ?)").run(documentKey, this.vectorBlob(vector));
      this.database.prepare("DELETE FROM search_embedding_jobs WHERE document_key=? AND content_hash=?").run(documentKey, contentHash);
    })();
  }

  async failEmbeddingJob(documentKey: string, contentHash: string, error: string, nextRetryAt: string, now: string): Promise<void> {
    const update = this.database.prepare(`UPDATE search_embedding_jobs SET status='failed', last_error=?, next_retry_at=?, updated_at=? WHERE document_key=? AND content_hash=? AND status='processing'`)
      .run(error.slice(0, 2000), nextRetryAt, now, documentKey, contentHash);
    expectOne(update.changes, `embedding job changed: ${documentKey}`);
  }

  async semanticSearch(vector: readonly number[], model: string, limit: number, visibility: VisibilityScope, options: { readonly excludeConversationId?: string; readonly beforeCreatedAt?: string; readonly minSimilarity?: number } = {}): Promise<readonly SearchHit[]> {
    if (!vector.length || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError("invalid semantic search input");
    this.ensureVectorIndex(model, vector.length);
    const candidateLimit = Math.min(1_000, Math.max(50, limit * 10));
    const rows = this.database.prepare(`WITH nearest AS (
      SELECT document_key, distance FROM search_embeddings_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance
    ) SELECT n.document_key,n.distance FROM nearest n JOIN search_embeddings e ON e.document_key=n.document_key
      WHERE e.model=? AND e.dimensions=? ORDER BY n.distance`).all(this.vectorBlob(vector), candidateLimit, model, vector.length) as Array<{ document_key: string; distance: number }>;
    return rows.flatMap(row => {
      const source = this.embeddingSource(row.document_key);
      if (!source) return [];
      const hit = { ...source.hit, rank: row.distance, semanticScore: 1 - row.distance };
      const visible = source.visibility
        ? searchDocumentVisible(source.visibility, visibility)
        : visibility.kind === "all" || visibility.principalIds.includes(hit.actorPrincipalId) || visibility.resources.some(resource => resource.kind === "conversation" && resource.id === hit.conversationId);
      if (!visible || (options.excludeConversationId && hit.conversationId === options.excludeConversationId) || (options.beforeCreatedAt && source.occurredAt && source.occurredAt >= options.beforeCreatedAt) || hit.semanticScore < (options.minSimilarity ?? -1)) return [];
      return [hit];
    }).slice(0, limit);
  }

  async rebuildEmbeddingProjection(): Promise<void> {
    this.database.transaction(() => { this.database.prepare("DELETE FROM search_embeddings").run(); if (this.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='search_embeddings_vec'").get()) this.database.prepare("DELETE FROM search_embeddings_vec").run(); this.database.prepare("DELETE FROM search_embedding_jobs").run(); this.seedEmbeddingJobs(); })();
  }

  async search(query: string, limit: number, visibility: VisibilityScope): Promise<readonly SearchHit[]> {
    const normalized = query.trim();
    if (!normalized) return [];
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError("search limit must be between 1 and 100");
    const allowed = visibility.kind === "all" ? undefined : {
      principals: [...new Set(visibility.principalIds)],
      conversations: [...new Set(visibility.resources.filter(resource => resource.kind === "conversation").map(resource => resource.id))],
    };
    const noConversationScope = allowed !== undefined && allowed.principals.length === 0 && allowed.conversations.length === 0;
    const filters: string[] = []; const filterValues: string[] = [];
    if (allowed) {
      if (allowed.principals.length) { filters.push(`actor_principal_id IN (${allowed.principals.map(() => "?").join(",")})`); filterValues.push(...allowed.principals); }
      if (allowed.conversations.length) { filters.push(`conversation_id IN (${allowed.conversations.map(() => "?").join(",")})`); filterValues.push(...allowed.conversations); }
    }
    const visibleSql = filters.length ? ` AND (${filters.join(" OR ")})` : "";
    const conversationHits: SearchHit[] = noConversationScope ? [] : [...normalized].length < 3
      ? this.database.prepare(`SELECT turn_id AS turnId, conversation_id AS conversationId, actor_principal_id AS actorPrincipalId, text, 0 AS rank
        FROM conversation_fts WHERE text LIKE ? ESCAPE '\\'${visibleSql} LIMIT ?`).all(`%${normalized.replace(/[\\%_]/g, "\\$&")}%`, ...filterValues, limit) as SearchHit[]
      : (() => {
    const ftsQuery = `"${normalized.replace(/"/g, '""')}"`;
    const rows = this.database.prepare(`SELECT turn_id AS turnId, conversation_id AS conversationId, actor_principal_id AS actorPrincipalId, text, bm25(conversation_fts) AS rank
      FROM conversation_fts WHERE conversation_fts MATCH ?${visibleSql} ORDER BY rank LIMIT ?`).all(ftsQuery, ...filterValues, limit) as SearchHit[];
    return rows;
      })();
    const escaped = `%${normalized.replace(/[\\%_]/g, "\\$&")}%`;
    const documentRows = [...normalized].length < 3
      ? this.database.prepare("SELECT f.namespace, f.document_id, f.source_type, f.source_id, f.text, d.visibility_json, d.conversation_id, d.actor_principal_id FROM search_documents_fts f JOIN search_documents d ON d.namespace=f.namespace AND d.document_id=f.document_id WHERE f.text LIKE ? ESCAPE '\\' LIMIT ?").all(escaped, Math.min(1000, limit * 10)) as Array<{ namespace: string; document_id: string; source_type: string; source_id: string; text: string; visibility_json: string; conversation_id: string | null; actor_principal_id: string | null }>
      : this.database.prepare("SELECT f.namespace, f.document_id, f.source_type, f.source_id, f.text, d.visibility_json, d.conversation_id, d.actor_principal_id FROM search_documents_fts f JOIN search_documents d ON d.namespace=f.namespace AND d.document_id=f.document_id WHERE search_documents_fts MATCH ? LIMIT ?").all(`"${normalized.replace(/"/g, '""')}"`, Math.min(1000, limit * 10)) as Array<{ namespace: string; document_id: string; source_type: string; source_id: string; text: string; visibility_json: string; conversation_id: string | null; actor_principal_id: string | null }>;
    const documentHits = documentRows.filter(row => searchDocumentVisible(parseJson<VisibilityScope>(row.visibility_json), visibility)).map(row => ({
      turnId: `document:${row.namespace}:${row.document_id}`,
      conversationId: row.conversation_id ?? `source:${row.source_type}:${row.source_id}`,
      actorPrincipalId: row.actor_principal_id ?? `namespace:${row.namespace}`,
      text: row.text,
      rank: 0,
      documentId: row.document_id,
      sourceType: row.source_type,
      sourceId: row.source_id,
    } satisfies SearchHit));
    return [...conversationHits, ...documentHits].slice(0, limit);
  }

  async replaceSearchSource(namespace: string, sourceId: string, documents: readonly SearchDocumentInput[]): Promise<void> {
    if (!/^[a-z0-9._-]{1,100}$/i.test(namespace) || !sourceId.trim()) throw new TypeError("invalid search source identity");
    if (documents.length > 1_000) throw new TypeError("search source has too many documents");
    this.database.transaction(() => {
      const oldKeys = this.database.prepare("SELECT 'document:' || namespace || ':' || document_id AS document_key FROM search_documents WHERE namespace=? AND source_group_id=?").all(namespace, sourceId) as Array<{ document_key: string }>;
      for (const { document_key } of oldKeys) this.removeEmbedding(document_key);
      const oldDocumentIds = this.database.prepare("SELECT document_id FROM search_documents WHERE namespace=? AND source_group_id=?").all(namespace, sourceId) as Array<{ document_id: string }>;
      for (const { document_id } of oldDocumentIds) this.database.prepare("DELETE FROM search_documents_fts WHERE namespace=? AND document_id=?").run(namespace, document_id);
      this.database.prepare("DELETE FROM search_documents WHERE namespace=? AND source_group_id=?").run(namespace, sourceId);
      const insertDocument = this.database.prepare("INSERT INTO search_documents(namespace,source_id,source_group_id,document_id,source_type,text,visibility_json,occurred_at,conversation_id,actor_principal_id) VALUES (?,?,?,?,?,?,?,?,?,?)");
      const insertFts = this.database.prepare("INSERT INTO search_documents_fts(namespace,document_id,source_type,source_id,text) VALUES (?,?,?,?,?)");
      for (const document of documents) {
        if (!/^[a-zA-Z0-9._:-]{1,200}$/.test(document.id) || !document.text.trim() || document.text.length > 200_000) throw new TypeError("invalid search document");
        if (!document.sourceId.trim()) throw new TypeError("invalid search document source identity");
        insertDocument.run(namespace, document.sourceId, sourceId, document.id, document.sourceType.slice(0, 100), document.text, json(document.visibility), document.occurredAt ?? null, document.conversationId ?? null, document.actorPrincipalId ?? null);
        insertFts.run(namespace, document.id, document.sourceType.slice(0, 100), document.sourceId, document.text);
        this.enqueueEmbedding(`document:${namespace}:${document.id}`, document.text);
      }
    })();
  }

  async removeSearchSource(namespace: string, sourceId: string): Promise<void> {
    this.database.transaction(() => {
      const keys = this.database.prepare("SELECT 'document:' || namespace || ':' || document_id AS document_key FROM search_documents WHERE namespace=? AND source_group_id=?").all(namespace, sourceId) as Array<{ document_key: string }>;
      for (const { document_key } of keys) this.removeEmbedding(document_key);
      const documentIds = this.database.prepare("SELECT document_id FROM search_documents WHERE namespace=? AND source_group_id=?").all(namespace, sourceId) as Array<{ document_id: string }>;
      for (const { document_id } of documentIds) this.database.prepare("DELETE FROM search_documents_fts WHERE namespace=? AND document_id=?").run(namespace, document_id);
      this.database.prepare("DELETE FROM search_documents WHERE namespace=? AND source_group_id=?").run(namespace, sourceId);
    })();
  }

  async listSearchNamespaces(): Promise<readonly string[]> {
    return (this.database.prepare("SELECT DISTINCT namespace FROM search_documents ORDER BY namespace").all() as Array<{ namespace: string }>).map(row => row.namespace);
  }

  async removeSearchNamespace(namespace: string): Promise<void> {
    if (!/^[a-z0-9._-]{1,100}$/i.test(namespace)) throw new TypeError("invalid search namespace");
    this.database.transaction(() => {
      const keys = this.database.prepare("SELECT 'document:' || namespace || ':' || document_id AS document_key FROM search_documents WHERE namespace=?").all(namespace) as Array<{ document_key: string }>;
      for (const { document_key } of keys) this.removeEmbedding(document_key);
      this.database.prepare("DELETE FROM search_documents_fts WHERE namespace=?").run(namespace);
      this.database.prepare("DELETE FROM search_documents WHERE namespace=?").run(namespace);
    })();
  }

  async rebuildSearchProjection(): Promise<void> {
    this.database.transaction(() => {
      this.database.prepare("DELETE FROM conversation_fts").run();
      const rows = this.database.prepare("SELECT t.*, o.text AS assistant_text FROM turns t LEFT JOIN run_outputs o ON o.run_id = t.primary_run_id ORDER BY t.conversation_id, t.sequence").all() as Array<TurnRow & { assistant_text: string | null }>;
      const insert = this.database.prepare("INSERT INTO conversation_fts(turn_id, conversation_id, actor_principal_id, text) VALUES (?, ?, ?, ?)");
      for (const row of rows) {
        const content = parseJson<Turn["content"]>(row.content_json);
        const text = this.turnProjectionText(content, row.primary_run_id, row.assistant_text ?? "");
        if (text.trim()) {
          insert.run(row.id, row.conversation_id, row.actor_principal_id, text);
          this.enqueueEmbedding(`turn:${row.id}`, text);
        }
      }
      const childKeys = this.database.prepare("SELECT 'document:core:' || document_id AS document_key FROM search_documents WHERE namespace='core' AND source_type='child_run_output'").all() as Array<{ document_key: string }>;
      for (const { document_key } of childKeys) this.removeEmbedding(document_key);
      this.database.prepare("DELETE FROM search_documents_fts WHERE namespace='core' AND source_type='child_run_output'").run();
      this.database.prepare("DELETE FROM search_documents WHERE namespace='core' AND source_type='child_run_output'").run();
      const childRuns = this.database.prepare("SELECT child.id FROM runs child JOIN run_outputs o ON o.run_id=child.id WHERE child.parent_run_id IS NOT NULL AND child.state='succeeded' ORDER BY child.created_at,child.id").all() as Array<{ id: string }>;
      for (const child of childRuns) this.refreshChildRunSearchProjection(child.id);
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

  async createChildRunWithStep(delegation: DelegationRecord, run: Run, firstStep: Step, concurrency?: { readonly principalId: string; readonly maxActiveChildren: number }): Promise<void> {
    if (run.parentRunId !== delegation.parentRunId || run.id !== delegation.childRunId) {
      throw new TypeError("delegation lineage must match the Child Run");
    }
    if (run.context.origin.kind !== "delegation" || run.context.origin.parentRunId !== delegation.parentRunId) {
      throw new TypeError("Child Run execution origin must reference its Parent Run");
    }
    this.database.transaction(() => {
      if (concurrency) {
        const active = this.database.prepare(`
          SELECT COUNT(*) AS count
          FROM delegations d
          JOIN runs child ON child.id = d.child_run_id
          JOIN runs parent ON parent.id = d.parent_run_id
          WHERE json_extract(parent.context_json, '$.actor.id') = ?
            AND child.state IN ('queued','running','waiting')
        `).get(concurrency.principalId) as { count: number };
        if (active.count >= concurrency.maxActiveChildren) throw new ExecutionStoreConflictError(`Principal ${concurrency.principalId} already has ${concurrency.maxActiveChildren} active Child Runs`);
      }
      this.insertRunWithStep(run, firstStep);
      this.database.prepare(`
        INSERT INTO delegations(
          id, parent_run_id, child_run_id, idempotency_key, task_json,
          budget_ceiling_json, agent_profile_ref, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        delegation.id,
        delegation.parentRunId,
        delegation.childRunId,
        delegation.idempotencyKey,
        json(delegation.task),
        delegation.budgetCeiling ? json(delegation.budgetCeiling) : null,
        null,
        delegation.state ?? "active",
        delegation.createdAt,
        delegation.updatedAt ?? delegation.createdAt,
      );
    })();
  }

  async getDelegation(delegationId: string): Promise<DelegationRecord | undefined> {
    const row = this.database.prepare("SELECT * FROM delegations WHERE id = ?").get(delegationId) as DelegationRow | undefined;
    return row ? this.delegationFromRow(row) : undefined;
  }

  async getDelegationByChildRunId(childRunId: string): Promise<DelegationRecord | undefined> {
    const row = this.database.prepare("SELECT * FROM delegations WHERE child_run_id = ?").get(childRunId) as DelegationRow | undefined;
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

  async cancelChildRun(parentRunId: string, childRunId: string, cancelledAt: string): Promise<boolean> {
    return this.database.transaction(() => {
      const row = this.database.prepare("SELECT state, revision FROM runs WHERE id=? AND parent_run_id=?").get(childRunId, parentRunId) as { state: RunState; revision: number } | undefined;
      if (!row) throw new ExecutionStoreConflictError(`Child Run ${childRunId} does not belong to Parent Run ${parentRunId}`);
      if (row.state === "cancelled") return true;
      if (["succeeded", "failed", "timed_out"].includes(row.state)) return false;
      assertRunTransition(row.state, "cancelled");
      expectOne(this.database.prepare("UPDATE runs SET revision=revision+1,state='cancelled',waiting_reason=NULL,resume_eligibility='ineligible',updated_at=? WHERE id=? AND parent_run_id=? AND state=? AND revision=?").run(cancelledAt, childRunId, parentRunId, row.state, row.revision).changes, `Child Run ${childRunId} changed concurrently`);
      this.database.prepare("UPDATE steps SET revision=revision+1,state='cancelled',updated_at=? WHERE run_id=? AND state IN ('pending','running')").run(cancelledAt, childRunId);
      this.database.prepare("DELETE FROM checkpoints WHERE run_id=?").run(childRunId);
      this.insertAudit("run.progressed", "run", childRunId, childRunId, { from: row.state, to: "cancelled", revision: row.revision + 1, checkpointCleared: true }, cancelledAt);
      this.insertAudit("delegation.cancelled", "run", childRunId, childRunId, { parentRunId }, cancelledAt);
      return true;
    })();
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
      state: row.state,
      createdAt: row.created_at,
      updatedAt: row.updated_at ?? row.created_at,
      ...(row.cancelled_at ? { cancelledAt: row.cancelled_at } : {}),
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
      this.refreshTurnSearchProjection(output.runId);
      this.refreshChildRunSearchProjection(output.runId);
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

  async createDeliveryIntent(delivery: DeliveryIntent): Promise<void> {
    if (delivery.state !== "pending" || delivery.deliveredAt !== undefined) throw new TypeError("new intermediate delivery must be pending");
    this.database.transaction(() => {
      const run = this.database.prepare("SELECT state FROM runs WHERE id=?").get(delivery.runId) as { state: RunState } | undefined;
      if (!run || !["running", "waiting", "failed", "cancelled"].includes(run.state)) throw new ExecutionStoreConflictError(`Run ${delivery.runId} cannot accept an intermediate or terminal delivery`);
      this.database.prepare("INSERT INTO delivery_intents(id,run_id,destination_json,payload_json,state,created_at,delivered_at) VALUES (?,?,?,?, 'pending', ?, NULL)").run(delivery.id, delivery.runId, json(delivery.destination), json(delivery.payload), delivery.createdAt);
      this.insertAudit("delivery.created", "delivery", delivery.id, delivery.runId, { state: "pending", intermediate: true }, delivery.createdAt);
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
      this.refreshTurnSearchProjection(runId);
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
        INSERT INTO operation_results(operation_id, outcome, effect_status, output_json, error_json, artifact_ids_json, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(operation_id) DO UPDATE SET
          outcome = excluded.outcome,
          effect_status = excluded.effect_status,
          output_json = excluded.output_json,
          error_json = excluded.error_json,
          artifact_ids_json = excluded.artifact_ids_json,
          completed_at = excluded.completed_at
      `).run(
        operationId,
        result.outcome,
        result.effectStatus,
        result.output === undefined ? null : json(result.output),
        result.error ? json(result.error) : null,
        result.artifactIds ? json(result.artifactIds) : null,
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
      this.refreshTurnSearchProjection(runId);
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
        SET revision = revision + 1, state = ?, waiting_reason = ?, interruption_json = ?, resume_eligibility = ?, context_json = COALESCE(?, context_json), updated_at = ?
        WHERE id = ? AND state = ? AND revision = ?
      `).run(
        update.runState,
        update.waitingReason ?? null,
        update.interruption ? json(update.interruption) : null,
        update.resumeEligibility,
        update.runContext ? json(update.runContext) : null,
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
      if (update.terminalDelivery) {
        if (update.runState !== "failed" && update.runState !== "cancelled") throw new TypeError("terminal delivery requires a failed or cancelled Run");
        if (update.terminalDelivery.runId !== update.runId || update.terminalDelivery.state !== "pending" || update.terminalDelivery.deliveredAt !== undefined) throw new TypeError("terminal delivery does not match the Run transition");
        this.database.prepare("INSERT INTO delivery_intents(id,run_id,destination_json,payload_json,state,created_at,delivered_at) VALUES (?,?,?,?, 'pending', ?, NULL)").run(update.terminalDelivery.id, update.runId, json(update.terminalDelivery.destination), json(update.terminalDelivery.payload), update.terminalDelivery.createdAt);
        this.insertAudit("delivery.created", "delivery", update.terminalDelivery.id, update.runId, { state: "pending", terminal: true }, update.terminalDelivery.createdAt);
      }
      if (update.consumedSteeredInputIds?.length) {
        const unique = [...new Set(update.consumedSteeredInputIds)];
        const consume = this.database.prepare("UPDATE run_steered_inputs SET state='consumed', consumed_at=? WHERE id=? AND run_id=? AND state='pending'");
        for (const id of unique) expectOne(consume.run(update.runUpdatedAt, id, update.runId).changes, `steered input ${id} changed concurrently`);
      }

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
          ...(update.runContext ? { authorityNarrowed: true } : {}),
          ...(update.consumedSteeredInputIds?.length ? { steeredInputsConsumed: update.consumedSteeredInputIds.length } : {}),
        },
        update.runUpdatedAt,
      );
    })();
  }

  async getRun(runId: string): Promise<Run | undefined> {
    const row = this.database.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as RunRow | undefined;
    return row ? this.runFromRow(row) : undefined;
  }

  async listRuns(limit = 50): Promise<readonly Run[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new TypeError("run list limit must be between 1 and 200");
    const rows = this.database.prepare("SELECT * FROM runs ORDER BY created_at DESC, id DESC LIMIT ?").all(limit) as RunRow[];
    return rows.map(row => this.runFromRow(row));
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
      ...(row.artifact_ids_json ? { artifactIds: parseJson<NonNullable<OperationResult["artifactIds"]>>(row.artifact_ids_json) } : {}),
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
      created_at: string; delivered_at: string | null; attempts: number; next_attempt_at: string | null; last_error: string | null; delivery_evidence_json: string | null;
    } | undefined;
    return row ? this.deliveryFromRow(row) : undefined;
  }

  async listPendingDeliveries(now = new Date().toISOString()): Promise<readonly DeliveryIntent[]> {
    const rows = this.database.prepare("SELECT * FROM delivery_intents WHERE state = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY created_at, id").all(now) as Array<{
      id: string; run_id: string; destination_json: string; payload_json: string; state: DeliveryIntent["state"];
      created_at: string; delivered_at: string | null; attempts: number; next_attempt_at: string | null; last_error: string | null; delivery_evidence_json: string | null;
    }>;
    return rows.map(row => this.deliveryFromRow(row));
  }

  async markDeliveryDelivered(deliveryId: string, deliveredAt: string, evidence?: JsonObject): Promise<void> {
    this.database.transaction(() => {
      const update = this.database.prepare(`
        UPDATE delivery_intents SET state = 'delivered', delivered_at = ?, delivery_evidence_json = ?, next_attempt_at = NULL, last_error = NULL
        WHERE id = ? AND state = 'pending'
      `).run(deliveredAt, evidence ? json(evidence) : null, deliveryId);
      expectOne(update.changes, `delivery ${deliveryId} changed concurrently`);
      const row = this.database.prepare("SELECT run_id FROM delivery_intents WHERE id = ?").get(deliveryId) as { run_id: string };
      this.insertAudit("delivery.delivered", "delivery", deliveryId, row.run_id, { state: "delivered", ...(evidence ? { evidence } : {}) }, deliveredAt);
    })();
  }

  async markDeliveryFailed(deliveryId: string, error: string, nextAttemptAt: string, occurredAt: string): Promise<void> {
    this.database.transaction(() => {
      const update = this.database.prepare("UPDATE delivery_intents SET attempts = attempts + 1, last_error = ?, next_attempt_at = ? WHERE id = ? AND state = 'pending'").run(error.slice(0, 2000), nextAttemptAt, deliveryId);
      expectOne(update.changes, `delivery ${deliveryId} changed concurrently`);
      const row = this.database.prepare("SELECT run_id, attempts FROM delivery_intents WHERE id = ?").get(deliveryId) as { run_id: string; attempts: number };
      this.insertAudit("delivery.failed", "delivery", deliveryId, row.run_id, { state: "pending", attempts: row.attempts, nextAttemptAt }, occurredAt);
    })();
  }

  private deliveryFromRow(row: {
    id: string; run_id: string; destination_json: string; payload_json: string; state: DeliveryIntent["state"];
    created_at: string; delivered_at: string | null; attempts: number; next_attempt_at: string | null; last_error: string | null; delivery_evidence_json: string | null;
  }): DeliveryIntent {
    return {
      id: row.id,
      runId: row.run_id,
      destination: parseJson<DeliveryIntent["destination"]>(row.destination_json),
      payload: parseJson<DeliveryIntent["payload"]>(row.payload_json),
      state: row.state,
      ...(row.attempts ? { attempts: row.attempts } : {}),
      createdAt: row.created_at,
      ...(row.delivered_at ? { deliveredAt: row.delivered_at } : {}),
      ...(row.next_attempt_at ? { nextAttemptAt: row.next_attempt_at } : {}),
      ...(row.last_error ? { lastError: row.last_error } : {}),
      ...(row.delivery_evidence_json ? { deliveryEvidence: parseJson<JsonObject>(row.delivery_evidence_json) } : {}),
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
