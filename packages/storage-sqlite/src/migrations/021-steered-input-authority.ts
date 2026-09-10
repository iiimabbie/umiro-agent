export const STEERED_INPUT_AUTHORITY_SCHEMA = `
ALTER TABLE run_steered_inputs ADD COLUMN authority_json TEXT NOT NULL
  DEFAULT '{"capabilities":[],"visibility":{"kind":"restricted","principalIds":[],"labels":[],"resources":[]},"instructionAuthority":"none"}'
  CHECK (json_valid(authority_json));
ALTER TABLE run_steered_inputs ADD COLUMN actor_roles_json TEXT NOT NULL
  DEFAULT '[]' CHECK (json_valid(actor_roles_json));
`;
