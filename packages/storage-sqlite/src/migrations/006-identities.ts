export const IDENTITIES_SCHEMA = `
CREATE TABLE transport_identities (
  transport TEXT NOT NULL,
  external_id TEXT NOT NULL,
  principal_id TEXT NOT NULL UNIQUE,
  display_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (transport, external_id)
);
`;
