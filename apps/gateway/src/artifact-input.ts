import type { Artifact, ArtifactStore } from "@umiro/core";
import type { ModelFilePart, ModelImagePart, ModelTextPart } from "@umiro/core/model";
import { extractArtifactText } from "./artifact-text.js";

export interface ArtifactModelRendition {
  readonly artifactId: string;
  /** An ephemeral URL; never persist this value in conversation history. */
  readonly url: string;
}

const MAX_MODEL_IMAGE_BYTES = 20 * 1024 * 1024;
const MODEL_IMAGE_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const MODEL_NATIVE_FILE_MEDIA_TYPES = new Set([
  "application/pdf", "text/plain", "text/markdown", "text/csv", "text/tsv", "application/json", "text/xml", "text/x-python", "text/x-c", "text/x-c++", "text/x-java", "text/x-javascript", "text/html", "text/css",
  "application/rtf", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.ms-word", "application/vnd.oasis.opendocument.text",
  "application/vnd.ms-powerpoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

export interface ModelImageBytes {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
}
export interface ResolvedArtifactBytes { readonly artifact: Artifact; readonly bytes: Uint8Array }
export type ArtifactBytesResolver = (artifact: Artifact) => Promise<ResolvedArtifactBytes>;

export async function resolveArtifactModelContent(input: {
  readonly artifactIds: readonly string[];
  readonly principalId: string;
  readonly store: ArtifactStore;
  readonly supportsVision: boolean;
  readonly protocol: "openai_responses" | "openai_chat_completions";
  readonly resolveArtifactBytes?: ArtifactBytesResolver;
}): Promise<readonly (ModelTextPart | ModelImagePart | ModelFilePart)[]> {
  const artifacts: Artifact[] = [];
  for (const id of input.artifactIds) {
    const artifact = await input.store.getArtifact(id);
    if (!artifact || artifact.state === "deleted" || !input.store.canAccessArtifact(artifact, input.principalId, artifact.visibility)) {
      throw new Error("workspace attachment is unavailable");
    }
    artifacts.push(artifact);
  }
  return artifactModelContent("", artifacts, input.supportsVision, input.protocol, [], undefined, input.resolveArtifactBytes);
}

/** Read either a transient Discord rendition or a local artifact for model input. */
export async function readModelImageBytes(artifact: Artifact, renditionUrl?: string, resolveArtifactBytes?: ArtifactBytesResolver): Promise<ModelImageBytes> {
  if (!renditionUrl) {
    if (!resolveArtifactBytes) throw new Error("workspace artifact resolver is unavailable");
    const resolved = await resolveArtifactBytes(artifact);
    return { bytes: resolved.bytes, mediaType: resolved.artifact.mediaType };
  }
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
  modelRenditions: readonly ArtifactModelRendition[] = [],
  onImageRenditionFailure?: (artifact: Artifact, error: unknown) => void,
  resolveArtifactBytes?: ArtifactBytesResolver,
): Promise<readonly (ModelTextPart | ModelImagePart | ModelFilePart)[]> {
  const content: Array<ModelTextPart | ModelImagePart | ModelFilePart> = [];
  if (prompt.trim()) content.push({ type: "text", text: prompt });
  const renditionMap = new Map(modelRenditions.map(item => [item.artifactId, item.url]));
  for (const artifact of artifacts) {
    const resolved = resolveArtifactBytes ? await resolveArtifactBytes(artifact) : undefined;
    const effectiveArtifact = resolved?.artifact ?? artifact;
    const effectiveMediaType = effectiveArtifact.mediaType.toLowerCase();
    const effectiveBaseMediaType = effectiveMediaType.split(";", 1)[0]!.trim();
    if (effectiveMediaType.startsWith("image/") && supportsVision) {
      const renditionUrl = renditionMap.get(artifact.id);
      if (!renditionUrl) {
        const image = resolved ? { bytes: resolved.bytes, mediaType: effectiveArtifact.mediaType } : await readModelImageBytes(effectiveArtifact, undefined, resolveArtifactBytes);
        content.push({ type: "image", url: `data:${image.mediaType};base64,${Buffer.from(image.bytes).toString("base64")}`, detail: "auto" });
      } else {
        try {
          const image = await readModelImageBytes(effectiveArtifact, renditionUrl);
          content.push({ type: "image", url: `data:${image.mediaType};base64,${Buffer.from(image.bytes).toString("base64")}`, detail: "auto" });
        } catch (error) {
          onImageRenditionFailure?.(effectiveArtifact, error);
          content.push({ type: "text", text: `Attached image ${effectiveArtifact.filename ?? effectiveArtifact.id} could not be loaded for vision input.` });
        }
      }
    } else if (MODEL_NATIVE_FILE_MEDIA_TYPES.has(effectiveBaseMediaType) && (protocol === "openai_responses" || effectiveBaseMediaType === "application/pdf")) {
      if (!resolved) throw new Error("workspace artifact resolver is unavailable");
      const bytes = resolved.bytes;
      if (bytes.byteLength > MAX_MODEL_IMAGE_BYTES) throw new Error(`model file exceeds ${MAX_MODEL_IMAGE_BYTES} byte limit`);
      content.push({ type: "text", text: `Attached file: ${effectiveArtifact.filename ?? effectiveArtifact.id}` });
      content.push({ type: "file", filename: effectiveArtifact.filename ?? `${effectiveArtifact.id}.pdf`, data: `data:${effectiveBaseMediaType};base64,${Buffer.from(bytes).toString("base64")}` });
    } else if (effectiveBaseMediaType.startsWith("text/") || effectiveBaseMediaType === "application/json" || effectiveArtifact.extractedText !== undefined) {
      if (!resolved) throw new Error("workspace artifact resolver is unavailable");
      const extracted = effectiveArtifact.extractedText ?? extractArtifactText(effectiveArtifact.mediaType, resolved.bytes);
      const bounded = extracted ? `${extracted.slice(0, 20_000)}${extracted.length > 20_000 ? "\n[attachment text truncated]" : ""}` : "[attachment content unavailable]";
      content.push({ type: "text", text: `Attached file ${effectiveArtifact.filename ?? effectiveArtifact.id}:\n${bounded}` });
    } else if (MODEL_NATIVE_FILE_MEDIA_TYPES.has(effectiveBaseMediaType) && protocol === "openai_chat_completions") {
      content.push({ type: "text", text: `Attached file ${effectiveArtifact.filename ?? effectiveArtifact.id} could not be converted to text for this model protocol.` });
    } else {
      content.push({ type: "text", text: `Attached file: ${effectiveArtifact.filename ?? effectiveArtifact.id} (${effectiveArtifact.mediaType}, ${effectiveArtifact.size} bytes)` });
    }
  }
  return content;
}
