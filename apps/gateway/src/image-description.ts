import { readFile } from "node:fs/promises";
import type { Artifact, ModelPort, ModelResponse } from "@umiro/core";
import type { ModelContent, ModelImagePart } from "@umiro/core/model";

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
): Promise<readonly ImageDescriptionResult[]> {
  const results: ImageDescriptionResult[] = [];
  for (const artifact of artifacts) {
    if (!artifact.mediaType.toLowerCase().split(";", 1)[0]!.startsWith("image/")) continue;
    if (signal?.aborted) throw signal.reason;
    const bytes = await readFile(artifact.location);
    const content: ModelContent = [
      { type: "text", text: "Describe this image for future semantic search. State the visible subjects, setting, readable text, and notable details. Do not guess hidden facts. Return only the concise description." },
      { type: "image", url: `data:${artifact.mediaType};base64,${bytes.toString("base64")}`, detail: "auto" } satisfies ModelImagePart,
    ];
    const response: ModelResponse = await model.generate({ model: modelName, messages: [{ role: "user", content }], maxOutputTokens: 800, ...(reasoningEffort ? { reasoningEffort } : {}), ...(signal ? { signal } : {}) });
    const description = response.text.trim().slice(0, MAX_DESCRIPTION_CHARACTERS);
    if (description) results.push({ artifactId: artifact.id, description });
  }
  return results;
}
