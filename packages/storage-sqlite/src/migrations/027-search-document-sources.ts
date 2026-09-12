export const SEARCH_DOCUMENT_SOURCES_SCHEMA = `
ALTER TABLE search_documents ADD COLUMN source_group_id TEXT;

UPDATE search_documents SET source_group_id = source_id;

CREATE INDEX search_documents_source_group
ON search_documents(namespace, source_group_id);
`;
