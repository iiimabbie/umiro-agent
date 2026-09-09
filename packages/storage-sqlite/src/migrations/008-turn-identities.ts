export const TURN_IDENTITIES_SCHEMA = `
ALTER TABLE turns ADD COLUMN actor_transport TEXT;
ALTER TABLE turns ADD COLUMN actor_external_id TEXT;
CREATE INDEX turns_actor_identity_idx ON turns(actor_transport, actor_external_id, created_at);
`;
