export const ARTIFACTS_SCHEMA = `
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  owner_principal_id TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('private','shared','public')),
  media_type TEXT NOT NULL,
  filename TEXT,
  size INTEGER NOT NULL CHECK (size >= 0),
  sha256 TEXT NOT NULL,
  location TEXT NOT NULL,
  parent_source_json TEXT CHECK (parent_source_json IS NULL OR json_valid(parent_source_json)),
  state TEXT NOT NULL CHECK (state IN ('stored','pending_delivery','delivered','deleted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX artifacts_owner_created ON artifacts(owner_principal_id, created_at);
CREATE INDEX artifacts_hash ON artifacts(sha256);
`;
