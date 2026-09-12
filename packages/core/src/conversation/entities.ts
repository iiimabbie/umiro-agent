import type { PrincipalId } from "../identity/principal.js";
import type { InputContentBlock } from "../input/event.js";
import type { ConversationId, RunState, TurnId } from "../run/entities.js";
import type { ReasoningEffort } from "../model/contract.js";
import type { ModelUsage } from "../model/contract.js";

export type ConversationState = "active" | "archived";

export interface Conversation {
  readonly id: ConversationId;
  readonly revision: number;
  readonly state: ConversationState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ConversationQueueMode = "queue" | "steer";

/** Durable preferences for a transport conversation locator. Unlike a single
 * Conversation transcript, these survive archive/new and describe the channel
 * or DM session itself. */
export interface ConversationPreferences {
  readonly transport: string;
  readonly externalId: string;
  readonly revision: number;
  readonly model?: string;
  readonly reasoningEffort?: ReasoningEffort;
  readonly queueMode?: ConversationQueueMode;
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
  readonly actorDisplayName?: string;
  readonly assistantText?: string;
  readonly assistantCreatedAt?: string;
  /** Bounded, redacted evidence from tools used by this Turn's Run. */
  readonly toolEvidence?: string;
}

/** Permanent transport location of one Conversation. Unlike the active
 * binding, this remains attached after archive and replacement. */
export interface ConversationLocation {
  readonly transport: string;
  readonly externalId: string;
  readonly kind: "direct" | "channel" | "thread";
}

export interface ConversationSummary {
  readonly conversation: Conversation;
  readonly location: ConversationLocation;
  readonly lastActivityAt: string;
  readonly turnCount: number;
  readonly firstText?: string;
}

export interface ConversationMessageItem {
  readonly turn: Turn;
  readonly actorDisplayName?: string;
  readonly reply?: {
    readonly runId: string;
    readonly state: RunState;
    readonly at: string;
    readonly text?: string;
    readonly usage?: ModelUsage;
  };
}

export interface ConversationMessagePage {
  readonly conversation: Conversation;
  readonly location: ConversationLocation;
  readonly messages: readonly ConversationMessageItem[];
  readonly hasMore: boolean;
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
