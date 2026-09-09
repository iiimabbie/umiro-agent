import type { TransportIdentity } from "../identity/principal.js";
import type { JsonObject } from "../ports/json.js";

export interface InputConversationLocator {
  readonly transport: string;
  readonly externalId: string;
  readonly kind: "direct" | "channel" | "thread";
}

export type InputContentBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "artifact_reference"; readonly artifactId: string };

/** Adapter-neutral ingress. Authorization begins only after identity resolution. */
export interface InputEvent {
  readonly id: string;
  readonly occurredAt: string;
  readonly identity: TransportIdentity;
  readonly conversation: InputConversationLocator;
  readonly content: readonly InputContentBlock[];
  readonly replyToExternalId?: string;
  readonly metadata?: JsonObject;
}

export function inputText(event: InputEvent): string {
  return event.content
    .filter((block): block is Extract<InputContentBlock, { type: "text" }> => block.type === "text")
    .map(block => block.text)
    .join("\n");
}
