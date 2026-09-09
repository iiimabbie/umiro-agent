export interface SearchHit {
  readonly turnId: string;
  readonly conversationId: string;
  readonly actorPrincipalId: string;
  readonly text: string;
  readonly rank: number;
}

export interface ConversationSearch {
  search(query: string, limit: number): Promise<readonly SearchHit[]>;
  rebuildSearchProjection(): Promise<void>;
}
