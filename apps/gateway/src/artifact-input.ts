import { readFile } from "node:fs/promises";
import type { Artifact } from "@umiro/core";
import type { ModelFilePart, ModelImagePart, ModelTextPart } from "@umiro/core/model";
import { extractArtifactText } from "./artifact-text.js";

/** Converts durable inbound artifacts into model input without silently dropping unsupported files. */
export async function artifactModelContent(prompt: string, artifacts: readonly Artifact[], supportsVision = true, protocol: "openai_responses" | "openai_chat_completions" = "openai_responses"): Promise<readonly (ModelTextPart | ModelImagePart | ModelFilePart)[]> {
  const content: Array<ModelTextPart | ModelImagePart | ModelFilePart> = [];
  if (prompt.trim()) content.push({ type: "text", text: prompt });
  for (const artifact of artifacts) {
    const mediaType = artifact.mediaType.toLowerCase();
    const baseMediaType = mediaType.split(";", 1)[0]!.trim();
    if (mediaType.startsWith("image/") && supportsVision) {
      const bytes = await readFile(artifact.location);
      content.push({ type: "image", url: `data:${artifact.mediaType};base64,${bytes.toString("base64")}`, detail: "auto" });
    } else if (baseMediaType === "application/pdf" && protocol === "openai_responses") {
      const bytes = await readFile(artifact.location);
      content.push({ type: "text", text: `Attached PDF: ${artifact.filename ?? artifact.id}` });
      content.push({ type: "file", filename: artifact.filename ?? `${artifact.id}.pdf`, data: `data:${artifact.mediaType};base64,${bytes.toString("base64")}` });
    } else if (baseMediaType.startsWith("text/") || baseMediaType === "application/json" || artifact.extractedText !== undefined) {
      const extracted = artifact.extractedText ?? extractArtifactText(artifact.mediaType, await readFile(artifact.location));
      const bounded = extracted ? `${extracted.slice(0, 20_000)}${extracted.length > 20_000 ? "\n[attachment text truncated]" : ""}` : "[attachment content unavailable]";
      content.push({ type: "text", text: `Attached file ${artifact.filename ?? artifact.id}:\n${bounded}` });
    } else {
      content.push({ type: "text", text: `Attached file: ${artifact.filename ?? artifact.id} (${artifact.mediaType}, ${artifact.size} bytes)` });
    }
  }
  return content;
}
