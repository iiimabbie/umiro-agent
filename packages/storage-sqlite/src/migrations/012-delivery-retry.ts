export const DELIVERY_RETRY_SCHEMA = `
ALTER TABLE delivery_intents ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0);
ALTER TABLE delivery_intents ADD COLUMN next_attempt_at TEXT;
ALTER TABLE delivery_intents ADD COLUMN last_error TEXT;
ALTER TABLE delivery_intents ADD COLUMN delivery_evidence_json TEXT CHECK (delivery_evidence_json IS NULL OR json_valid(delivery_evidence_json));
CREATE INDEX delivery_pending_retry ON delivery_intents(state, next_attempt_at, created_at);
`;
