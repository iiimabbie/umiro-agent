import type { Conversation, ConversationCompaction, ConversationHistoryItem, ConversationPreferences, ConversationQueueMode, ConversationState, Turn } from "./entities.js";
import type { ReasoningEffort } from "../model/contract.js";
import type { PrincipalId } from "../identity/principal.js";
import type { InputEvent } from "../input/event.js";
import type { ModelContent } from "../model/contract.js";

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

export interface UpdateConversationPreferencesRequest {
  readonly transport: string;
  readonly externalId: string;
  readonly expectedRevision: number;
  readonly model?: string;
  readonly reasoningEffort?: ReasoningEffort;
  readonly queueMode?: ConversationQueueMode;
  readonly updatedAt: string;
}

export interface ConversationPreferenceStore {
  getConversationPreferences(transport: string, externalId: string): Promise<ConversationPreferences | undefined>;
  updateConversationPreferences(request: UpdateConversationPreferencesRequest): Promise<ConversationPreferences>;
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
  refreshConversationCompaction(request: {
    readonly conversationId: string;
    readonly beforeSequence: number;
    readonly retainRecent: number;
    readonly maxCharacters: number;
    readonly updatedAt: string;
  }): Promise<ConversationCompaction | undefined>;
  archiveBoundConversation(transport: string, externalId: string, archivedAt: string): Promise<Conversation | undefined>;
}

export interface IngestInputEventRequest {
  readonly event: InputEvent;
  readonly actorPrincipalId: PrincipalId;
  readonly newConversationId: string;
  readonly newTurnId: string;
  /** Omitted for an observed Turn that intentionally has no Run. */
  readonly newRunId?: string;
  readonly createdAt: string;
}

export interface IngestInputEventResult {
  readonly conversation: Conversation;
  readonly turn: Turn;
  readonly duplicate: boolean;
  readonly conversationCreated: boolean;
}

export interface SteerInputEventRequest {
  readonly event: InputEvent;
  readonly actorPrincipalId: PrincipalId;
  readonly runId: string;
  readonly newTurnId: string;
  readonly modelContent: ModelContent;
  readonly createdAt: string;
}

export interface SteerInputEventResult {
  readonly conversation: Conversation;
  readonly turn: Turn;
  readonly duplicate: boolean;
}

export interface ConversationIngressStore extends Pick<ConversationStore, "listTurns" | "listRecentHistory" | "refreshConversationCompaction"> {
  ingestInputEvent(request: IngestInputEventRequest): Promise<IngestInputEventResult>;
  /** Records only when an active binding already exists; never creates a Conversation or Run. */
  observeInputEvent(request: IngestInputEventRequest): Promise<IngestInputEventResult | undefined>;
  /** Atomically appends a canonical Turn and queues it for an already-running Run. */
  steerInputEvent(request: SteerInputEventRequest): Promise<SteerInputEventResult>;
}
