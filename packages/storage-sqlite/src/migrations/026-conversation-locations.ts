export const CONVERSATION_LOCATIONS_SCHEMA = `
CREATE TABLE conversation_locations (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  transport TEXT NOT NULL,
  external_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('direct','channel','thread')),
  created_at TEXT NOT NULL
);

CREATE INDEX conversation_locations_scope
ON conversation_locations(transport, external_id, conversation_id);

INSERT INTO conversation_locations(conversation_id, transport, external_id, kind, created_at)
SELECT conversation_id, transport, external_id, kind, created_at
FROM conversation_bindings;

INSERT OR IGNORE INTO conversation_locations(conversation_id, transport, external_id, kind, created_at)
SELECT
  t.conversation_id,
  'discord',
  json_extract(d.destination_json, '$.channelId'),
  COALESCE(s.kind, 'channel'),
  c.created_at
FROM turns t
JOIN conversations c ON c.id = t.conversation_id
JOIN delivery_intents d ON d.run_id = t.primary_run_id
LEFT JOIN conversation_scopes s
  ON s.transport = 'discord'
 AND s.external_id = json_extract(d.destination_json, '$.channelId')
WHERE json_extract(d.destination_json, '$.kind') = 'discord'
  AND json_type(d.destination_json, '$.channelId') = 'text'
GROUP BY t.conversation_id;
`;
