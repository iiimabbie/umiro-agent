export const CONVERSATION_PREFERENCES_SCHEMA = `
CREATE TABLE conversation_preferences (
  transport TEXT NOT NULL,
  external_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  model TEXT,
  reasoning_effort TEXT CHECK (reasoning_effort IS NULL OR reasoning_effort IN ('default','low','medium','high','xhigh')),
  queue_mode TEXT CHECK (queue_mode IS NULL OR queue_mode IN ('followup','steer')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (transport, external_id),
  CHECK ((model IS NULL AND reasoning_effort IS NULL) OR (model IS NOT NULL AND reasoning_effort IS NOT NULL))
);
`;
