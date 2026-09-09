export const CONVERSATION_EMBEDDINGS_SCHEMA = `
CREATE TABLE conversation_embeddings (
  turn_id TEXT PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL CHECK (dimensions > 0),
  vector_json TEXT NOT NULL CHECK (json_valid(vector_json) AND json_type(vector_json) = 'array'),
  updated_at TEXT NOT NULL
);

CREATE TABLE conversation_embedding_jobs (
  turn_id TEXT PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','processing','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_retry_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX conversation_embedding_jobs_ready ON conversation_embedding_jobs(status, next_retry_at, updated_at);
`;
