export const SCHEDULER_SCHEMA = `
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
CREATE INDEX scheduled_triggers_due ON scheduled_triggers(enabled, next_fire_at);

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
CREATE INDEX scheduled_occurrences_retry ON scheduled_occurrences(status, next_retry_at);

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
`;
