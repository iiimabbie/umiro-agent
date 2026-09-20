import type Database from "better-sqlite3";

export const CURRENT_SCHEMA = `
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  state TEXT NOT NULL CHECK (state IN ('queued','running','waiting','succeeded','failed','cancelled','timed_out')),
  context_json TEXT NOT NULL CHECK (json_valid(context_json)),
  conversation_id TEXT,
  turn_id TEXT,
  parent_run_id TEXT REFERENCES runs(id),
  waiting_reason TEXT,
  interruption_json TEXT CHECK (interruption_json IS NULL OR json_valid(interruption_json)),
  resume_eligibility TEXT NOT NULL CHECK (resume_eligibility IN ('not_applicable','eligible','manual_review','ineligible')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('model_call','operation')),
  state TEXT NOT NULL CHECK (state IN ('pending','running','succeeded','failed','cancelled','timed_out')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (run_id, sequence)
);

CREATE TABLE authorization_decisions (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE,
  allow INTEGER NOT NULL CHECK (allow IN (0, 1)),
  reason TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('common','sensitive','privileged')),
  interaction_requirement TEXT NOT NULL CHECK (interaction_requirement IN ('not_required','interactive_required')),
  resource_json TEXT CHECK (resource_json IS NULL OR json_valid(resource_json)),
  decided_at TEXT NOT NULL
);

CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  step_id TEXT NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  input_json TEXT NOT NULL CHECK (json_valid(input_json) AND json_type(input_json) = 'object'),
  state TEXT NOT NULL CHECK (state IN ('proposed','authorized','denied','executing','succeeded','failed','outcome_unknown','cancelled')),
  capability TEXT NOT NULL,
  authorization_tier TEXT NOT NULL CHECK (authorization_tier IN ('common','sensitive','privileged')),
  side_effect TEXT NOT NULL CHECK (side_effect IN ('none','idempotent','non_idempotent')),
  idempotency_key TEXT,
  authorization_decision_id TEXT NOT NULL UNIQUE REFERENCES authorization_decisions(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (side_effect != 'idempotent' OR (idempotency_key IS NOT NULL AND length(trim(idempotency_key)) > 0)),
  CHECK (side_effect != 'non_idempotent' OR idempotency_key IS NULL)
);

CREATE TABLE operation_results (
  operation_id TEXT PRIMARY KEY REFERENCES operations(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded','failed','outcome_unknown','cancelled')),
  effect_status TEXT NOT NULL CHECK (effect_status IN ('not_applicable','confirmed','unknown')),
  output_json TEXT CHECK (output_json IS NULL OR json_valid(output_json)),
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  completed_at TEXT NOT NULL,
  artifact_ids_json TEXT CHECK (artifact_ids_json IS NULL OR json_valid(artifact_ids_json)),
  CHECK (outcome != 'outcome_unknown' OR effect_status = 'unknown'),
  CHECK (outcome != 'succeeded' OR error_json IS NULL),
  CHECK (outcome != 'failed' OR error_json IS NOT NULL),
  CHECK (outcome != 'cancelled' OR (error_json IS NOT NULL AND effect_status != 'unknown'))
);

CREATE TABLE checkpoints (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1),
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  updated_at TEXT NOT NULL
);

CREATE TABLE model_calls (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL UNIQUE REFERENCES steps(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  messages_json TEXT NOT NULL CHECK (json_valid(messages_json)),
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  created_at TEXT NOT NULL
);

CREATE TABLE run_outputs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  usage_json TEXT NOT NULL CHECK (json_valid(usage_json)),
  created_at TEXT NOT NULL
);

CREATE TABLE audit_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('run','step','operation','authorization','model_call','output','delivery')),
  entity_id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(id),
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  occurred_at TEXT NOT NULL
);

CREATE TABLE delivery_intents (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  destination_json TEXT NOT NULL CHECK (json_valid(destination_json) AND json_type(destination_json) = 'object'),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object'),
  state TEXT NOT NULL CHECK (state IN ('pending','delivered')),
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TEXT,
  last_error TEXT,
  delivery_evidence_json TEXT CHECK (delivery_evidence_json IS NULL OR json_valid(delivery_evidence_json)),
  CHECK ((state = 'pending' AND delivered_at IS NULL) OR (state = 'delivered' AND delivered_at IS NOT NULL))
);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  state TEXT NOT NULL CHECK (state IN ('active','archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE turns (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  actor_principal_id TEXT NOT NULL,
  input_event_id TEXT NOT NULL UNIQUE,
  primary_run_id TEXT UNIQUE,
  content_json TEXT NOT NULL CHECK (json_valid(content_json) AND json_type(content_json) = 'array'),
  reply_to_turn_id TEXT REFERENCES turns(id),
  created_at TEXT NOT NULL,
  actor_transport TEXT,
  actor_external_id TEXT,
  UNIQUE (conversation_id, sequence)
);

CREATE TABLE delegations (
  id TEXT PRIMARY KEY,
  parent_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  child_run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  task_json TEXT NOT NULL CHECK (json_valid(task_json) AND json_type(task_json) = 'object'),
  budget_ceiling_json TEXT CHECK (budget_ceiling_json IS NULL OR (json_valid(budget_ceiling_json) AND json_type(budget_ceiling_json) = 'object')),
  agent_profile_ref TEXT,
  created_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','waiting','succeeded','failed','cancelled')),
  updated_at TEXT,
  cancelled_at TEXT,
  UNIQUE (parent_run_id, idempotency_key)
);

CREATE TABLE conversation_bindings (
  transport TEXT NOT NULL,
  external_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('direct','channel','thread')),
  conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (transport, external_id)
);

CREATE TABLE transport_identities (
  transport TEXT NOT NULL,
  external_id TEXT NOT NULL,
  principal_id TEXT NOT NULL UNIQUE,
  display_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (transport, external_id)
);

CREATE VIRTUAL TABLE conversation_fts USING fts5(
  turn_id UNINDEXED,
  conversation_id UNINDEXED,
  actor_principal_id UNINDEXED,
  text,
  tokenize = 'trigram'
);

CREATE TABLE scheduled_triggers (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  schedule_json TEXT NOT NULL CHECK (json_valid(schedule_json)),
  timezone TEXT NOT NULL,
  job_ref TEXT NOT NULL,
  input_json TEXT NOT NULL CHECK (json_valid(input_json) AND json_type(input_json)='object'),
  creator_principal_id TEXT NOT NULL,
  creator_roles_json TEXT NOT NULL CHECK (json_valid(creator_roles_json) AND json_type(creator_roles_json)='array'),
  authority_json TEXT NOT NULL CHECK (json_valid(authority_json) AND json_type(authority_json)='object'),
  destination_json TEXT CHECK (destination_json IS NULL OR (json_valid(destination_json) AND json_type(destination_json)='object')),
  misfire_policy TEXT NOT NULL CHECK (misfire_policy IN ('catch_up','coalesce','skip')),
  max_attempts INTEGER NOT NULL CHECK (max_attempts >= 1),
  retry_backoff_ms INTEGER NOT NULL CHECK (retry_backoff_ms >= 0),
  next_fire_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE scheduled_occurrences (
  id TEXT PRIMARY KEY,
  trigger_id TEXT NOT NULL REFERENCES scheduled_triggers(id) ON DELETE CASCADE,
  scheduled_for TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed')),
  attempts INTEGER NOT NULL CHECK (attempts >= 1),
  run_id TEXT NOT NULL UNIQUE,
  next_retry_at TEXT,
  error TEXT,
  claimed_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(trigger_id, scheduled_for)
);

CREATE TABLE scheduled_occurrence_attempts (
  occurrence_id TEXT NOT NULL REFERENCES scheduled_occurrences(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL,
  run_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed')),
  claimed_at TEXT NOT NULL,
  completed_at TEXT,
  error TEXT,
  PRIMARY KEY(occurrence_id, attempt)
);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  owner_principal_id TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('private','shared','public')),
  media_type TEXT NOT NULL,
  filename TEXT,
  size INTEGER NOT NULL CHECK (size >= 0),
  sha256 TEXT NOT NULL,
  location TEXT NOT NULL,
  parent_source_json TEXT CHECK (parent_source_json IS NULL OR json_valid(parent_source_json)),
  state TEXT NOT NULL CHECK (state IN ('stored','pending_delivery','delivered','deleted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  extracted_text TEXT
);

CREATE TABLE conversation_compactions (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  through_sequence INTEGER NOT NULL CHECK (through_sequence >= 0),
  source_hash TEXT NOT NULL,
  summary TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE plugin_state (
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  value BLOB NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT,
  PRIMARY KEY (namespace, key)
);

CREATE TABLE conversation_preferences (
  transport TEXT NOT NULL,
  external_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  model TEXT,
  reasoning_effort TEXT CHECK (reasoning_effort IS NULL OR reasoning_effort IN ('default','low','medium','high','xhigh')),
  queue_mode TEXT CHECK (queue_mode IS NULL OR queue_mode IN ('queue','steer')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (transport, external_id),
  CHECK ((model IS NULL AND reasoning_effort IS NULL) OR (model IS NOT NULL AND reasoning_effort IS NOT NULL))
);

CREATE TABLE run_steered_inputs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL UNIQUE REFERENCES turns(id) ON DELETE CASCADE,
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  state TEXT NOT NULL CHECK (state IN ('pending','consumed')),
  created_at TEXT NOT NULL,
  consumed_at TEXT,
  authority_json TEXT NOT NULL DEFAULT '{"capabilities":[],"visibility":{"kind":"restricted","principalIds":[],"labels":[],"resources":[]},"instructionAuthority":"none"}' CHECK (json_valid(authority_json)),
  actor_roles_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(actor_roles_json))
);

CREATE TABLE search_documents (
  namespace TEXT NOT NULL,
  source_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  text TEXT NOT NULL,
  visibility_json TEXT NOT NULL CHECK (json_valid(visibility_json)),
  occurred_at TEXT,
  conversation_id TEXT,
  actor_principal_id TEXT,
  source_group_id TEXT,
  PRIMARY KEY (namespace, document_id)
);

CREATE VIRTUAL TABLE search_documents_fts USING fts5(
  namespace UNINDEXED,
  document_id UNINDEXED,
  source_type UNINDEXED,
  source_id UNINDEXED,
  text,
  tokenize = 'trigram'
);

CREATE TABLE search_embeddings (
  document_key TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL CHECK (dimensions > 0),
  vector_json TEXT NOT NULL CHECK (json_valid(vector_json) AND json_type(vector_json) = 'array'),
  updated_at TEXT NOT NULL
);

CREATE TABLE search_embedding_jobs (
  document_key TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','processing','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_retry_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE conversation_scopes (
  transport TEXT NOT NULL,
  external_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('direct','channel','thread')),
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (transport, external_id)
);

CREATE TABLE conversation_locations (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  transport TEXT NOT NULL,
  external_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('direct','channel','thread')),
  created_at TEXT NOT NULL
);

CREATE TABLE artifact_workspace_entries (
  artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL UNIQUE,
  original_filename TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active','modified','missing','trashed')),
  device TEXT,
  inode TEXT,
  materialized_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX operations_idempotency ON operations(kind, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX operations_step ON operations(step_id);
CREATE INDEX steps_run_sequence ON steps(run_id, sequence);
CREATE INDEX audit_events_run_sequence ON audit_events(run_id, sequence);
CREATE INDEX delivery_pending_retry ON delivery_intents(state, next_attempt_at, created_at);
CREATE INDEX delivery_run_created ON delivery_intents(run_id, created_at, id);
CREATE INDEX turns_conversation_sequence ON turns(conversation_id, sequence);
CREATE INDEX turns_actor_identity_idx ON turns(actor_transport, actor_external_id, created_at);
CREATE INDEX delegations_parent_created ON delegations(parent_run_id, created_at, id);
CREATE INDEX scheduled_triggers_due ON scheduled_triggers(enabled, next_fire_at);
CREATE INDEX scheduled_occurrences_retry ON scheduled_occurrences(status, next_retry_at);
CREATE INDEX artifacts_owner_created ON artifacts(owner_principal_id, created_at);
CREATE INDEX artifacts_hash ON artifacts(sha256);
CREATE INDEX plugin_state_expiry ON plugin_state(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX run_steered_inputs_pending ON run_steered_inputs(run_id, state, created_at, id);
CREATE INDEX search_documents_source ON search_documents(namespace, source_id);
CREATE INDEX search_documents_source_group ON search_documents(namespace, source_group_id);
CREATE INDEX search_embedding_jobs_ready ON search_embedding_jobs(status, next_retry_at, updated_at);
CREATE INDEX conversation_locations_scope ON conversation_locations(transport, external_id, conversation_id);
CREATE INDEX artifact_workspace_entries_state ON artifact_workspace_entries(state);
CREATE INDEX artifact_workspace_entries_identity ON artifact_workspace_entries(device, inode);

CREATE TRIGGER delegations_sync_child_state
AFTER UPDATE OF state, updated_at ON runs
WHEN NEW.parent_run_id IS NOT NULL
BEGIN
  UPDATE delegations SET
    state = CASE NEW.state
      WHEN 'waiting' THEN 'waiting'
      WHEN 'succeeded' THEN 'succeeded'
      WHEN 'cancelled' THEN 'cancelled'
      WHEN 'failed' THEN 'failed'
      WHEN 'timed_out' THEN 'failed'
      ELSE 'active' END,
    updated_at = NEW.updated_at,
    cancelled_at = CASE WHEN NEW.state = 'cancelled' THEN NEW.updated_at ELSE cancelled_at END
  WHERE child_run_id = NEW.id;
END;
`;

export function initializeSchema(database: Database.Database): void {
  const initialized = database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='runs'",
  ).get();
  if (!initialized) database.transaction(() => database.exec(CURRENT_SCHEMA))();
}
