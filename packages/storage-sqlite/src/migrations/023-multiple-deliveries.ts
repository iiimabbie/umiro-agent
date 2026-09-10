export const MULTIPLE_DELIVERIES_SCHEMA = `
ALTER TABLE delivery_intents RENAME TO delivery_intents_v22;

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

INSERT INTO delivery_intents(id,run_id,destination_json,payload_json,state,created_at,delivered_at,attempts,next_attempt_at,last_error,delivery_evidence_json)
SELECT id,run_id,destination_json,payload_json,state,created_at,delivered_at,attempts,next_attempt_at,last_error,delivery_evidence_json
FROM delivery_intents_v22;

DROP TABLE delivery_intents_v22;
CREATE INDEX delivery_pending_retry ON delivery_intents(state, next_attempt_at, created_at);
CREATE INDEX delivery_run_created ON delivery_intents(run_id, created_at, id);
`;
