export const INITIAL_SCHEMA = `
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

CREATE UNIQUE INDEX operations_idempotency
  ON operations(kind, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE operation_results (
  operation_id TEXT PRIMARY KEY REFERENCES operations(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded','failed','outcome_unknown','cancelled')),
  effect_status TEXT NOT NULL CHECK (effect_status IN ('not_applicable','confirmed','unknown')),
  output_json TEXT CHECK (output_json IS NULL OR json_valid(output_json)),
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  completed_at TEXT NOT NULL,
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
  entity_type TEXT NOT NULL CHECK (entity_type IN ('run','step','operation','authorization','model_call','output')),
  entity_id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(id),
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  occurred_at TEXT NOT NULL
);

CREATE INDEX steps_run_sequence ON steps(run_id, sequence);
CREATE INDEX operations_step ON operations(step_id);
CREATE INDEX audit_events_run_sequence ON audit_events(run_id, sequence);
`;
