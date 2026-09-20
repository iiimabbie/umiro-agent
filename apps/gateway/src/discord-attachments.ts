import type { Artifact, PrincipalId } from "@umiro/core";
import type { IncomingAttachment } from "./artifact-files.js";
import type { ArtifactModelRendition } from "./artifact-input.js";
import { boundedDiscordImageUrl } from "./discord-image.js";

export interface DiscordAttachmentImporter {
  importDiscord(attachment: IncomingAttachment, ownerPrincipalId: PrincipalId, sourceMessageId: string): Promise<Artifact>;
}

export interface DiscordAttachmentImportFailure {
  readonly filename: string;
  readonly reason: string;
  readonly error: unknown;
}

/** Imports attachments independently so one unavailable file cannot discard the message. */
export async function importDiscordAttachments(
  importer: DiscordAttachmentImporter,
  attachments: readonly IncomingAttachment[],
  ownerPrincipalId: PrincipalId,
  sourceMessageId: string,
  onFailure: (failure: DiscordAttachmentImportFailure) => void,
): Promise<{ readonly artifacts: readonly Artifact[]; readonly modelRenditions: readonly ArtifactModelRendition[]; readonly promptSuffix: string }> {
  const artifacts: Artifact[] = [];
  const modelRenditions: ArtifactModelRendition[] = [];
  const unavailable: string[] = [];
  for (const attachment of attachments) {
    try {
      const artifact = await importer.importDiscord(attachment, ownerPrincipalId, sourceMessageId);
      artifacts.push(artifact);
      modelRenditions.push({ artifactId: artifact.id, url: boundedDiscordImageUrl(attachment.url, attachment.width, attachment.height) });
    } catch (error) {
      const filename = attachment.filename || "unnamed attachment";
      const reason = attachmentFailureReason(error);
      unavailable.push(`${filename}: ${reason}`);
      onFailure({ filename, reason, error });
    }
  }
  return {
    artifacts,
    modelRenditions,
    promptSuffix: unavailable.length > 0
      ? `\n[Attachments unavailable; continue with the message text]\n${unavailable.map(item => `- ${item}`).join("\n")}`
      : "",
  };
}

/** Rebuild an ephemeral rendition map when a reply's original artifact is already stored. */
export function mapDiscordAttachmentRenditions(
  attachments: readonly IncomingAttachment[],
  artifacts: readonly Artifact[],
): readonly ArtifactModelRendition[] {
  const unused = new Set(attachments.keys());
  const result: ArtifactModelRendition[] = [];
  for (const artifact of artifacts) {
    const index = [...unused].find(candidate => attachments[candidate]?.filename === artifact.filename)
      ?? [...unused][0];
    if (index === undefined) continue;
    unused.delete(index);
    const attachment = attachments[index];
    if (attachment) result.push({ artifactId: artifact.id, url: boundedDiscordImageUrl(attachment.url, attachment.width, attachment.height) });
  }
  return result;
}

function attachmentFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("attachment exceeds ")) return "file is larger than the configured limit";
  if (message.startsWith("attachment download failed: HTTP ")) return "Discord download failed";
  if (message === "untrusted Discord attachment URL") return "Discord returned an unsupported download URL";
  if (error instanceof DOMException && error.name === "TimeoutError") return "Discord download timed out";
  return "file could not be imported";
}
