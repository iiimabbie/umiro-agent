import { readFile } from "node:fs/promises";
import type { Artifact } from "@umiro/core";
import type { ModelImagePart, ModelTextPart } from "@umiro/core/model";

const MAX_EXTRACTED_CHARACTERS = 200_000;

/** Converts durable inbound artifacts into model input without silently dropping unsupported files. */
export async function artifactModelContent(prompt: string, artifacts: readonly Artifact[]): Promise<readonly (ModelTextPart | ModelImagePart)[]> {
  const content: Array<ModelTextPart | ModelImagePart> = [];
  if (prompt.trim()) content.push({ type: "text", text: prompt });
  for (const artifact of artifacts) {
    const mediaType = artifact.mediaType.toLowerCase();
    if (mediaType.startsWith("image/")) {
      const bytes = await readFile(artifact.location);
      content.push({ type: "image", url: `data:${artifact.mediaType};base64,${bytes.toString("base64")}`, detail: "auto" });
    } else if (mediaType.startsWith("text/") || mediaType === "application/json") {
      const bytes = await readFile(artifact.location);
      content.push({ type: "text", text: `Attached file ${artifact.filename ?? artifact.id}:\n${bytes.toString("utf8").slice(0, MAX_EXTRACTED_CHARACTERS)}` });
    } else {
      content.push({ type: "text", text: `Attached file: ${artifact.filename ?? artifact.id} (${artifact.mediaType}, ${artifact.size} bytes)` });
    }
  }
  return content;
}
