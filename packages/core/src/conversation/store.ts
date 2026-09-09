import type { Conversation, ConversationHistoryItem, ConversationState, Turn } from "./entities.js";
import type { PrincipalId } from "../identity/principal.js";
import type { InputEvent } from "../input/event.js";

export interface AppendTurnRequest {
  readonly turn: Turn;
  readonly expectedConversationRevision: number;
  readonly conversationUpdatedAt: string;
}

export interface UpdateConversationStateRequest {
  readonly conversationId: string;
  readonly expectedRevision: number;
  readonly expectedState: ConversationState;
  readonly state: ConversationState;
  readonly updatedAt: string;
}

export interface ConversationStore {
  createConversationWithTurn(conversation: Conversation, firstTurn: Turn): Promise<void>;
  appendTurn(request: AppendTurnRequest): Promise<void>;
  updateConversationState(request: UpdateConversationStateRequest): Promise<void>;
  getConversation(conversationId: string): Promise<Conversation | undefined>;
  getTurn(turnId: string): Promise<Turn | undefined>;
  getTurnByInputEventId(inputEventId: string): Promise<Turn | undefined>;
  listTurns(conversationId: string, limit?: number): Promise<readonly Turn[]>;
  listRecentHistory(conversationId: string, beforeSequence: number, limit: number): Promise<readonly ConversationHistoryItem[]>;
  archiveBoundConversation(transport: string, externalId: string, archivedAt: string): Promise<Conversation | undefined>;
}

export interface IngestInputEventRequest {
  readonly event: InputEvent;
  readonly actorPrincipalId: PrincipalId;
  readonly newConversationId: string;
  readonly newTurnId: string;
  /** Required while ingress supports trigger only; becomes optional for future observe-only Turns. */
  readonly newRunId: string;
  readonly createdAt: string;
}

export interface IngestInputEventResult {
  readonly conversation: Conversation;
  readonly turn: Turn;
  readonly duplicate: boolean;
  readonly conversationCreated: boolean;
}

export interface ConversationIngressStore extends Pick<ConversationStore, "listTurns" | "listRecentHistory"> {
  ingestInputEvent(request: IngestInputEventRequest): Promise<IngestInputEventResult>;
}
