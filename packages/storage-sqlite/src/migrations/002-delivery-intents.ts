export const DELIVERY_INTENTS_SCHEMA = `
CREATE TABLE delivery_intents (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
  destination_json TEXT NOT NULL CHECK (json_valid(destination_json) AND json_type(destination_json) = 'object'),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object'),
  state TEXT NOT NULL CHECK (state IN ('pending','delivered')),
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  CHECK ((state = 'pending' AND delivered_at IS NULL) OR (state = 'delivered' AND delivered_at IS NOT NULL))
);

ALTER TABLE audit_events RENAME TO audit_events_v1;

CREATE TABLE audit_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('run','step','operation','authorization','model_call','output','delivery')),
  entity_id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(id),
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  occurred_at TEXT NOT NULL
);

INSERT INTO audit_events(sequence, kind, entity_type, entity_id, run_id, data_json, occurred_at)
SELECT sequence, kind, entity_type, entity_id, run_id, data_json, occurred_at FROM audit_events_v1;

DROP TABLE audit_events_v1;
CREATE INDEX audit_events_run_sequence ON audit_events(run_id, sequence);
`;
