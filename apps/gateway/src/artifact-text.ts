export const MAX_EXTRACTED_CHARACTERS = 200_000;

export function extractArtifactText(mediaType: string, bytes: Uint8Array): string | undefined {
  const normalized = mediaType.toLowerCase().split(";", 1)[0]!.trim();
  if (!normalized.startsWith("text/") && normalized !== "application/json") return undefined;
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes).slice(0, MAX_EXTRACTED_CHARACTERS);
}
