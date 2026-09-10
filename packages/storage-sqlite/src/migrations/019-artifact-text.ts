export const ARTIFACT_TEXT_SCHEMA = `
ALTER TABLE artifacts ADD COLUMN extracted_text TEXT;
`;
