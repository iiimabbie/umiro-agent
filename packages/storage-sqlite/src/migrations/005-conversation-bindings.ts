export const CONVERSATION_BINDINGS_SCHEMA = `
CREATE TABLE conversation_bindings (
  transport TEXT NOT NULL,
  external_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('direct','channel','thread')),
  conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (transport, external_id)
);
`;
