export const SOURCE_EMBEDDINGS_SCHEMA = `
ALTER TABLE search_documents ADD COLUMN conversation_id TEXT;
ALTER TABLE search_documents ADD COLUMN actor_principal_id TEXT;

CREATE TABLE search_embeddings (
  document_key TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL CHECK (dimensions > 0),
  vector_json TEXT NOT NULL CHECK (json_valid(vector_json) AND json_type(vector_json) = 'array'),
  updated_at TEXT NOT NULL
);

CREATE TABLE search_embedding_jobs (
  document_key TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','processing','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_retry_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX search_embedding_jobs_ready ON search_embedding_jobs(status, next_retry_at, updated_at);

INSERT INTO search_embeddings(document_key,content_hash,model,dimensions,vector_json,updated_at)
SELECT 'turn:' || turn_id,content_hash,model,dimensions,vector_json,updated_at
FROM conversation_embeddings;

INSERT INTO search_embedding_jobs(document_key,content_hash,status,attempts,next_retry_at,last_error,updated_at)
SELECT 'turn:' || turn_id,content_hash,status,attempts,next_retry_at,last_error,updated_at
FROM conversation_embedding_jobs;

DROP TABLE IF EXISTS conversation_embeddings_vec;
DROP TABLE conversation_embedding_jobs;
DROP TABLE conversation_embeddings;
`;
