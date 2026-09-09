export const OPERATION_ARTIFACTS_SCHEMA = `
ALTER TABLE operation_results ADD COLUMN artifact_ids_json TEXT CHECK (artifact_ids_json IS NULL OR json_valid(artifact_ids_json));
`;
