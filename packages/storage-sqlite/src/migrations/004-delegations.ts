export const DELEGATIONS_SCHEMA = `
CREATE TABLE delegations (
  id TEXT PRIMARY KEY,
  parent_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  child_run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  task_json TEXT NOT NULL CHECK (json_valid(task_json) AND json_type(task_json) = 'object'),
  budget_ceiling_json TEXT CHECK (budget_ceiling_json IS NULL OR (json_valid(budget_ceiling_json) AND json_type(budget_ceiling_json) = 'object')),
  agent_profile_ref TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (parent_run_id, idempotency_key)
);

CREATE INDEX delegations_parent_created ON delegations(parent_run_id, created_at, id);
`;
