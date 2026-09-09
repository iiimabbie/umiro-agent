export const CONVERSATION_COMPACTIONS_SCHEMA = `
CREATE TABLE conversation_compactions (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  through_sequence INTEGER NOT NULL CHECK (through_sequence >= 0),
  source_hash TEXT NOT NULL,
  summary TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;
