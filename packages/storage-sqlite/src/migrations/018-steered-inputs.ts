export const STEERED_INPUTS_SCHEMA = `
ALTER TABLE conversation_preferences RENAME TO conversation_preferences_v17;

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

INSERT INTO conversation_preferences(transport,external_id,revision,model,reasoning_effort,queue_mode,updated_at)
SELECT transport,external_id,revision,model,reasoning_effort,CASE queue_mode WHEN 'followup' THEN 'queue' ELSE queue_mode END,updated_at
FROM conversation_preferences_v17;

DROP TABLE conversation_preferences_v17;

CREATE TABLE run_steered_inputs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL UNIQUE REFERENCES turns(id) ON DELETE CASCADE,
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  state TEXT NOT NULL CHECK (state IN ('pending','consumed')),
  created_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE INDEX run_steered_inputs_pending ON run_steered_inputs(run_id, state, created_at, id);
`;
