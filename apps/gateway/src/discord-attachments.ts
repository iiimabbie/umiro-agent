import type { Artifact, PrincipalId } from "@umiro/core";
import type { IncomingAttachment } from "./artifact-files.js";

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
): Promise<{ readonly artifacts: readonly Artifact[]; readonly promptSuffix: string }> {
  const artifacts: Artifact[] = [];
  const unavailable: string[] = [];
  for (const attachment of attachments) {
    try {
      artifacts.push(await importer.importDiscord(attachment, ownerPrincipalId, sourceMessageId));
    } catch (error) {
      const filename = attachment.filename || "unnamed attachment";
      const reason = attachmentFailureReason(error);
      unavailable.push(`${filename}: ${reason}`);
      onFailure({ filename, reason, error });
    }
  }
  return {
    artifacts,
    promptSuffix: unavailable.length > 0
      ? `\n[Attachments unavailable; continue with the message text]\n${unavailable.map(item => `- ${item}`).join("\n")}`
      : "",
  };
}

function attachmentFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("attachment exceeds ")) return "file is larger than the configured limit";
  if (message.startsWith("attachment download failed: HTTP ")) return "Discord download failed";
  if (message === "untrusted Discord attachment URL") return "Discord returned an unsupported download URL";
  if (error instanceof DOMException && error.name === "TimeoutError") return "Discord download timed out";
  return "file could not be imported";
}
