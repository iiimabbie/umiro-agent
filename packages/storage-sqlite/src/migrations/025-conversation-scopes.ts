export const CONVERSATION_SCOPES_SCHEMA = `
CREATE TABLE conversation_scopes (
  transport TEXT NOT NULL,
  external_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('direct','channel','thread')),
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (transport, external_id)
);

INSERT INTO conversation_scopes(transport, external_id, kind, created_at, last_seen_at)
SELECT b.transport, b.external_id, b.kind, b.created_at, c.updated_at
FROM conversation_bindings b
JOIN conversations c ON c.id = b.conversation_id;
`;
