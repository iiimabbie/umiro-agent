import type { PrincipalId } from "../identity/principal.js";
import type { InputContentBlock } from "../input/event.js";
import type { ConversationId, TurnId } from "../run/entities.js";

export type ConversationState = "active" | "archived";

export interface Conversation {
  readonly id: ConversationId;
  readonly revision: number;
  readonly state: ConversationState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Turn {
  readonly id: TurnId;
  readonly conversationId: ConversationId;
  readonly sequence: number;
  readonly actorPrincipalId: PrincipalId;
  /** Trusted transport identity captured at ingress for adapter-neutral context
   * selection. It is display/context metadata and never grants authority. */
  readonly actorIdentity?: { readonly transport: string; readonly externalId: string };
  readonly inputEventId: string;
  readonly primaryRunId?: string;
  readonly content: readonly InputContentBlock[];
  readonly replyToTurnId?: TurnId;
  readonly createdAt: string;
}

export interface ConversationHistoryItem {
  readonly turn: Turn;
  readonly assistantText?: string;
}

/** A rebuildable, lossy projection of canonical conversation turns that fell
 * outside the recent-history window. Canonical Turns and Run outputs remain
 * untouched. */
export interface ConversationCompaction {
  readonly conversationId: ConversationId;
  readonly throughSequence: number;
  readonly sourceHash: string;
  readonly summary: string;
  readonly updatedAt: string;
}
