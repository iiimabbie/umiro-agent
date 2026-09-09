export interface SearchHit {
  readonly turnId: string;
  readonly conversationId: string;
  readonly actorPrincipalId: string;
  readonly text: string;
  readonly rank: number;
  readonly semanticScore?: number;
}

export interface EmbeddingJob {
  readonly turnId: string;
  readonly text: string;
  readonly contentHash: string;
  readonly attempts: number;
}

export interface EmbeddingProjection {
  prepareEmbeddingModel(model: string): Promise<void>;
  claimEmbeddingJobs(limit: number, now: string, staleBefore: string): Promise<readonly EmbeddingJob[]>;
  completeEmbeddingJob(turnId: string, contentHash: string, model: string, vector: readonly number[], now: string): Promise<void>;
  failEmbeddingJob(turnId: string, contentHash: string, error: string, nextRetryAt: string, now: string): Promise<void>;
  semanticSearch(vector: readonly number[], model: string, limit: number, visibility: VisibilityScope, options?: { readonly excludeConversationId?: string; readonly beforeCreatedAt?: string; readonly minSimilarity?: number }): Promise<readonly SearchHit[]>;
  rebuildEmbeddingProjection(): Promise<void>;
}

export interface ConversationSearch {
  search(query: string, limit: number, visibility: VisibilityScope): Promise<readonly SearchHit[]>;
  rebuildSearchProjection(): Promise<void>;
}
import type { VisibilityScope } from "../authorization/authority.js";
