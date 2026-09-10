export const DELEGATION_STATE_SCHEMA = `
ALTER TABLE delegations ADD COLUMN state TEXT NOT NULL DEFAULT 'active'
  CHECK (state IN ('active','waiting','succeeded','failed','cancelled'));
ALTER TABLE delegations ADD COLUMN updated_at TEXT;
ALTER TABLE delegations ADD COLUMN cancelled_at TEXT;

UPDATE delegations
SET state = CASE (SELECT state FROM runs WHERE runs.id = delegations.child_run_id)
  WHEN 'waiting' THEN 'waiting'
  WHEN 'succeeded' THEN 'succeeded'
  WHEN 'cancelled' THEN 'cancelled'
  WHEN 'failed' THEN 'failed'
  WHEN 'timed_out' THEN 'failed'
  ELSE 'active' END,
  updated_at = COALESCE((SELECT updated_at FROM runs WHERE runs.id = delegations.child_run_id), created_at),
  cancelled_at = CASE WHEN (SELECT state FROM runs WHERE runs.id = delegations.child_run_id) = 'cancelled'
    THEN (SELECT updated_at FROM runs WHERE runs.id = delegations.child_run_id) ELSE NULL END;

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
