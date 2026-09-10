export const PLUGIN_STATE_SCHEMA = `
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

CREATE INDEX plugin_state_expiry ON plugin_state(expires_at) WHERE expires_at IS NOT NULL;
`;
