export const ARTIFACT_WORKSPACE_ENTRIES_SCHEMA = `
CREATE TABLE artifact_workspace_entries (
  artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL UNIQUE,
  original_filename TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active','modified','missing','trashed')),
  device TEXT,
  inode TEXT,
  materialized_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX artifact_workspace_entries_state ON artifact_workspace_entries(state);
CREATE INDEX artifact_workspace_entries_identity ON artifact_workspace_entries(device, inode);
`;
