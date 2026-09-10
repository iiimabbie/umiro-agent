export const SEARCH_DOCUMENTS_SCHEMA = `
CREATE TABLE search_documents (
  namespace TEXT NOT NULL,
  source_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  text TEXT NOT NULL,
  visibility_json TEXT NOT NULL CHECK (json_valid(visibility_json)),
  occurred_at TEXT,
  PRIMARY KEY (namespace, document_id)
);
CREATE INDEX search_documents_source ON search_documents(namespace, source_id);
CREATE VIRTUAL TABLE search_documents_fts USING fts5(
  namespace UNINDEXED,
  document_id UNINDEXED,
  source_type UNINDEXED,
  source_id UNINDEXED,
  text,
  tokenize = 'trigram'
);
`;
