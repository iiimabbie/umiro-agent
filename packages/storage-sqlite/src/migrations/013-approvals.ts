export const APPROVALS_SCHEMA = `
CREATE TABLE approval_requests (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  state TEXT NOT NULL CHECK (state IN ('pending','approved','denied','expired','consumed')),
  required_role TEXT NOT NULL CHECK (required_role = 'owner'),
  requested_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  resolved_by_principal_id TEXT,
  resolved_at TEXT,
  consumed_at TEXT,
  CHECK (expires_at > requested_at),
  CHECK ((state = 'pending' AND resolved_by_principal_id IS NULL AND resolved_at IS NULL AND consumed_at IS NULL)
    OR (state IN ('approved','denied') AND resolved_by_principal_id IS NOT NULL AND resolved_at IS NOT NULL AND consumed_at IS NULL)
    OR (state = 'expired' AND resolved_at IS NOT NULL AND consumed_at IS NULL)
    OR (state = 'consumed' AND resolved_by_principal_id IS NOT NULL AND resolved_at IS NOT NULL AND consumed_at IS NOT NULL))
);

CREATE INDEX approval_requests_pending ON approval_requests(state, expires_at, requested_at);

ALTER TABLE audit_events RENAME TO audit_events_v12;

CREATE TABLE audit_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('run','step','operation','authorization','approval','model_call','output','delivery')),
  entity_id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(id),
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  occurred_at TEXT NOT NULL
);

INSERT INTO audit_events(sequence, kind, entity_type, entity_id, run_id, data_json, occurred_at)
SELECT sequence, kind, entity_type, entity_id, run_id, data_json, occurred_at FROM audit_events_v12;

DROP TABLE audit_events_v12;
CREATE INDEX audit_events_run_sequence ON audit_events(run_id, sequence);
`;
