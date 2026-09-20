import { readFile } from "node:fs/promises";
import type { Artifact } from "@umiro/core";
import type { ModelFilePart, ModelImagePart, ModelTextPart } from "@umiro/core/model";
import { extractArtifactText } from "./artifact-text.js";

export interface ArtifactModelRendition {
  readonly artifactId: string;
  /** An ephemeral URL; never persist this value in conversation history. */
  readonly url: string;
}

const MAX_MODEL_IMAGE_BYTES = 20 * 1024 * 1024;
const MODEL_IMAGE_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export interface ModelImageBytes {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
}

/** Read either a transient Discord rendition or a local artifact for model input. */
export async function readModelImageBytes(artifact: Artifact, renditionUrl?: string): Promise<ModelImageBytes> {
  if (!renditionUrl) return { bytes: new Uint8Array(await readFile(artifact.location)), mediaType: artifact.mediaType };
  const response = await fetch(renditionUrl, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`model image rendition fetch failed: HTTP ${response.status}`);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MODEL_IMAGE_BYTES) throw new Error(`model image rendition exceeds ${MAX_MODEL_IMAGE_BYTES} byte limit`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_MODEL_IMAGE_BYTES) throw new Error(`model image rendition exceeds ${MAX_MODEL_IMAGE_BYTES} byte limit`);
  const mediaType = (response.headers.get("content-type") ?? artifact.mediaType).split(";", 1)[0]!.trim().toLowerCase();
  if (!MODEL_IMAGE_MEDIA_TYPES.has(mediaType)) throw new Error(`model image rendition returned unsupported content-type: ${mediaType || "missing"}`);
  return { bytes, mediaType };
}

/** Converts durable inbound artifacts into model input without silently dropping unsupported files. */
export async function artifactModelContent(
  prompt: string,
  artifacts: readonly Artifact[],
  supportsVision = true,
  protocol: "openai_responses" | "openai_chat_completions" = "openai_responses",
  modelRenditions?: ReadonlyMap<string, string> | readonly ArtifactModelRendition[],
  onImageRenditionFailure?: (artifact: Artifact, error: unknown) => void,
): Promise<readonly (ModelTextPart | ModelImagePart | ModelFilePart)[]> {
  const content: Array<ModelTextPart | ModelImagePart | ModelFilePart> = [];
  if (prompt.trim()) content.push({ type: "text", text: prompt });
  let renditionMap: ReadonlyMap<string, string>;
  if (modelRenditions === undefined) renditionMap = new Map();
  else if (Array.isArray(modelRenditions)) renditionMap = new Map(modelRenditions.map((item: ArtifactModelRendition) => [item.artifactId, item.url]));
  else renditionMap = modelRenditions as ReadonlyMap<string, string>;
  for (const artifact of artifacts) {
    const mediaType = artifact.mediaType.toLowerCase();
    const baseMediaType = mediaType.split(";", 1)[0]!.trim();
    if (mediaType.startsWith("image/") && supportsVision) {
      const renditionUrl = renditionMap.get(artifact.id);
      if (!renditionUrl) {
        const image = await readModelImageBytes(artifact);
        content.push({ type: "image", url: `data:${image.mediaType};base64,${Buffer.from(image.bytes).toString("base64")}`, detail: "auto" });
      } else {
        try {
          const image = await readModelImageBytes(artifact, renditionUrl);
          content.push({ type: "image", url: `data:${image.mediaType};base64,${Buffer.from(image.bytes).toString("base64")}`, detail: "auto" });
        } catch (error) {
          onImageRenditionFailure?.(artifact, error);
          content.push({ type: "text", text: `Attached image ${artifact.filename ?? artifact.id} could not be loaded for vision input.` });
        }
      }
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
