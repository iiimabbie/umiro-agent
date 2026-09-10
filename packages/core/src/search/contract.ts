export interface SearchHit {
  readonly turnId: string;
  readonly conversationId: string;
  readonly actorPrincipalId: string;
  readonly text: string;
  readonly rank: number;
  readonly semanticScore?: number;
  readonly documentId?: string;
  readonly sourceType?: string;
  readonly sourceId?: string;
}

export interface SearchDocumentInput {
  readonly id: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly text: string;
  readonly visibility: VisibilityScope;
  readonly occurredAt?: string;
}

/** Plugin-facing facade; namespace is injected by PluginHost and cannot be forged. */
export interface PluginSearchDocuments {
  replaceSource(sourceId: string, documents: readonly SearchDocumentInput[]): Promise<void>;
  removeSource(sourceId: string): Promise<void>;
}

/** Host/storage port. The namespace boundary is applied before Plugins receive it. */
export interface SearchDocumentProjection {
  replaceSearchSource(namespace: string, sourceId: string, documents: readonly SearchDocumentInput[]): Promise<void>;
  removeSearchSource(namespace: string, sourceId: string): Promise<void>;
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
