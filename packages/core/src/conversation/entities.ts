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
  readonly inputEventId: string;
  readonly primaryRunId?: string;
  readonly content: readonly InputContentBlock[];
  readonly replyToTurnId?: TurnId;
  readonly createdAt: string;
}
