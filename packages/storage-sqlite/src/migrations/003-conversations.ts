export const CONVERSATIONS_SCHEMA = `
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  state TEXT NOT NULL CHECK (state IN ('active','archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE turns (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  actor_principal_id TEXT NOT NULL,
  input_event_id TEXT NOT NULL UNIQUE,
  primary_run_id TEXT UNIQUE,
  content_json TEXT NOT NULL CHECK (json_valid(content_json) AND json_type(content_json) = 'array'),
  reply_to_turn_id TEXT REFERENCES turns(id),
  created_at TEXT NOT NULL,
  UNIQUE (conversation_id, sequence)
);

CREATE INDEX turns_conversation_sequence ON turns(conversation_id, sequence);
`;
