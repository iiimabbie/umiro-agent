export const CONVERSATION_SEARCH_SCHEMA = `
CREATE VIRTUAL TABLE conversation_fts USING fts5(
  turn_id UNINDEXED,
  conversation_id UNINDEXED,
  actor_principal_id UNINDEXED,
  text,
  tokenize = 'trigram'
);
`;
