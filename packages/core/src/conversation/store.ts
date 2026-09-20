import type { Conversation, ConversationCompaction, ConversationHistoryItem, ConversationMessagePage, ConversationPreferences, ConversationQueueMode, ConversationState, ConversationSummary, Turn } from "./entities.js";
import type { TurnId } from "../run/entities.js";
import type { ReasoningEffort } from "../model/contract.js";
import type { PrincipalId, PrincipalRole } from "../identity/principal.js";
import type { InputContentBlock, InputEvent } from "../input/event.js";
import type { ModelContent } from "../model/contract.js";
import type { Authority } from "../authorization/authority.js";

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

export interface ArchiveActiveConversationsRequest {
  readonly transport: string;
  readonly cutoff: string;
  readonly archivedAt: string;
  readonly excludeExternalIds?: readonly string[];
  readonly externalIds?: readonly string[];
}

export interface ArchivedConversationReference {
  readonly conversationId: string;
  readonly externalId: string;
}

export interface ArchiveActiveConversationsResult {
  readonly archived: readonly ArchivedConversationReference[];
  readonly skipped: readonly ArchivedConversationReference[];
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
  getHistoryItem(turnId: string): Promise<ConversationHistoryItem | undefined>;
  listTurns(conversationId: string, limit?: number): Promise<readonly Turn[]>;
  listRecentHistory(conversationId: string, beforeSequence: number, limit: number): Promise<readonly ConversationHistoryItem[]>;
  listConversations(filter: { readonly transport?: string; readonly externalId?: string; readonly state?: ConversationState; readonly limit?: number }): Promise<readonly ConversationSummary[]>;
  listConversationMessages(conversationId: string, limit?: number, after?: number): Promise<ConversationMessagePage | undefined>;
  refreshConversationCompaction(request: {
    readonly conversationId: string;
    readonly beforeSequence: number;
    readonly retainRecent: number;
    readonly maxCharacters: number;
    readonly updatedAt: string;
  }): Promise<ConversationCompaction | undefined>;
  archiveBoundConversation(transport: string, externalId: string, archivedAt: string): Promise<Conversation | undefined>;
  archiveBoundConversationIfCurrent(transport: string, externalId: string, conversationId: string, archivedAt: string): Promise<Conversation | undefined>;
  archiveActiveConversationsBefore(request: ArchiveActiveConversationsRequest): Promise<ArchiveActiveConversationsResult>;
}

export interface IngestInputEventRequest {
  readonly event: InputEvent;
  readonly actorPrincipalId: PrincipalId;
  readonly newConversationId: string;
  readonly newTurnId: string;
  /** Omitted for an observed Turn that intentionally has no Run. */
  readonly newRunId?: string;
  /** Optional sequence-zero context turns, inserted atomically only when a
   * new Conversation binding is created. */
  readonly initialTurns?: readonly ConversationSeedTurn[];
  readonly createdAt: string;
}

export interface ConversationSeedTurn {
  readonly id: TurnId;
  readonly actorPrincipalId: PrincipalId;
  readonly actorIdentity?: { readonly transport: string; readonly externalId: string };
  readonly inputEventId: string;
  readonly content: readonly InputContentBlock[];
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
  /** Authority resolved for the participant who supplied this steer. */
  readonly authority: Authority;
  readonly actorRoles: readonly PrincipalRole[];
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

export interface ConversationIngressStore extends Pick<ConversationStore, "getHistoryItem" | "listTurns" | "listRecentHistory" | "refreshConversationCompaction"> {
  ingestInputEvent(request: IngestInputEventRequest): Promise<IngestInputEventResult>;
  /** True only after this transport location has triggered the agent at least once. */
  hasConversationScope(transport: string, externalId: string): Promise<boolean>;
  /** Records only inside an established scope; may open a fresh Conversation after archive, but never creates a Run. */
  observeInputEvent(request: IngestInputEventRequest): Promise<IngestInputEventResult | undefined>;
  /** Atomically appends a canonical Turn and queues it for an already-running Run. */
  steerInputEvent(request: SteerInputEventRequest): Promise<SteerInputEventResult>;
}
