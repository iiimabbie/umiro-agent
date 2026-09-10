import { readFile } from "node:fs/promises";
import type { Artifact } from "@umiro/core";
import type { ModelImagePart, ModelTextPart } from "@umiro/core/model";
import { extractArtifactText } from "./artifact-text.js";

/** Converts durable inbound artifacts into model input without silently dropping unsupported files. */
export async function artifactModelContent(prompt: string, artifacts: readonly Artifact[], supportsVision = true): Promise<readonly (ModelTextPart | ModelImagePart)[]> {
  const content: Array<ModelTextPart | ModelImagePart> = [];
  if (prompt.trim()) content.push({ type: "text", text: prompt });
  for (const artifact of artifacts) {
    const mediaType = artifact.mediaType.toLowerCase();
    const baseMediaType = mediaType.split(";", 1)[0]!.trim();
    if (mediaType.startsWith("image/") && supportsVision) {
      const bytes = await readFile(artifact.location);
      content.push({ type: "image", url: `data:${artifact.mediaType};base64,${bytes.toString("base64")}`, detail: "auto" });
    } else if (baseMediaType.startsWith("text/") || baseMediaType === "application/json") {
      const extracted = artifact.extractedText ?? extractArtifactText(artifact.mediaType, await readFile(artifact.location));
      content.push({ type: "text", text: `Attached file ${artifact.filename ?? artifact.id}:\n${extracted ?? ""}` });
    } else {
      content.push({ type: "text", text: `Attached file: ${artifact.filename ?? artifact.id} (${artifact.mediaType}, ${artifact.size} bytes)` });
    }
  }
  return content;
}
