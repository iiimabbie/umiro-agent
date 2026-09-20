import type { Artifact, ModelPort, ModelResponse } from "@umiro/core";
import type { ModelContent, ModelImagePart } from "@umiro/core/model";
import { readModelImageBytes, type ArtifactModelRendition } from "./artifact-input.js";

const MAX_DESCRIPTION_CHARACTERS = 6_000;

export interface ImageDescriptionResult {
  readonly artifactId: string;
  readonly description?: string;
}

/** Produces bounded, explicitly descriptive text for image artifacts after the user Run. */
export async function describeImageArtifacts(
  model: ModelPort,
  modelName: string,
  artifacts: readonly Artifact[],
  signal?: AbortSignal,
  reasoningEffort?: import("@umiro/core").ReasoningEffort,
  modelRenditions: readonly ArtifactModelRendition[] = [],
  onImageRenditionFailure?: (artifact: Artifact, error: unknown) => void,
): Promise<readonly ImageDescriptionResult[]> {
  const results: ImageDescriptionResult[] = [];
  const renditionMap = new Map(modelRenditions.map(item => [item.artifactId, item.url]));
  for (const artifact of artifacts) {
    if (!artifact.mediaType.toLowerCase().split(";", 1)[0]!.startsWith("image/")) continue;
    if (signal?.aborted) throw signal.reason;
    const renditionUrl = renditionMap.get(artifact.id);
    let image;
    if (!renditionUrl) {
      image = await readModelImageBytes(artifact);
    } else {
      try {
        image = await readModelImageBytes(artifact, renditionUrl);
      } catch (error) {
        onImageRenditionFailure?.(artifact, error);
        continue;
      }
    }
    const content: ModelContent = [
      { type: "text", text: "Describe this image for future semantic search. State the visible subjects, setting, readable text, and notable details. Do not guess hidden facts. Return only the concise description." },
      { type: "image", url: `data:${image.mediaType};base64,${Buffer.from(image.bytes).toString("base64")}`, detail: "auto" } satisfies ModelImagePart,
    ];
    const response: ModelResponse = await model.generate({ model: modelName, messages: [{ role: "user", content }], maxOutputTokens: 800, ...(reasoningEffort ? { reasoningEffort } : {}), ...(signal ? { signal } : {}) });
    const description = response.text.trim().slice(0, MAX_DESCRIPTION_CHARACTERS);
    if (description) results.push({ artifactId: artifact.id, description });
  }
  return results;
}
