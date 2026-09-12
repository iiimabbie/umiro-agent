export const MAX_EXTRACTED_CHARACTERS = 200_000;

const officeTypes = new Map<string, string>([
  ["application/pdf", "pdf"], ["application/rtf", "rtf"], ["text/rtf", "rtf"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"],
  ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "pptx"],
  ["application/vnd.oasis.opendocument.text", "odt"], ["application/vnd.oasis.opendocument.spreadsheet", "ods"],
  ["application/vnd.oasis.opendocument.presentation", "odp"], ["application/epub+zip", "epub"],
]);

export function extractArtifactText(mediaType: string, bytes: Uint8Array): string | undefined {
  const normalized = mediaType.toLowerCase().split(";", 1)[0]!.trim();
  if (!normalized.startsWith("text/") && normalized !== "application/json") return undefined;
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes).slice(0, MAX_EXTRACTED_CHARACTERS);
}

/** Extracts formats that are not safely decodable as UTF-8 in the request path. */
export async function extractArtifactTextAsync(mediaType: string, bytes: Uint8Array): Promise<string | undefined> {
  const normalized = mediaType.toLowerCase().split(";", 1)[0]!.trim();
  if (normalized.startsWith("text/") || normalized === "application/json") return extractArtifactText(mediaType, bytes);
  const fileType = officeTypes.get(normalized);
  if (!fileType) return undefined;
  try {
    const { parseOffice } = await import("officeparser");
    const ast = await parseOffice(bytes, { fileType } as never);
    const text = ast.toText().trim();
    return text ? text.slice(0, MAX_EXTRACTED_CHARACTERS) : undefined;
  } catch {
    return undefined;
  }
}
