import type { ContextProvider } from "@umiro/core/context";
import type { EmbeddingProjection } from "@umiro/core/search";
import type { TextEmbedder } from "./embedding-worker.js";
import { NOOP_LOGGER, type StructuredLogger } from "@umiro/core/observability";

export class SemanticRecallProvider implements ContextProvider {
  readonly id = "context.semantic_recall";
  readonly role = "recalled-memories";
  readonly priority = 800;
  constructor(private readonly search: EmbeddingProjection, private readonly embedder: TextEmbedder, private readonly now = () => new Date(), private readonly logger: StructuredLogger = NOOP_LOGGER, private options: { readonly limit?: number; readonly minSimilarity?: number; readonly timeoutMs?: number } = {}) {}
  configure(options: { readonly limit?: number; readonly minSimilarity?: number }): void { this.options = { ...this.options, ...options }; }
  async load(request: Parameters<ContextProvider["load"]>[0]) {
    const query = request.prompt.trim(); if (!query) return [];
    try {
      const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 2_000);
      const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
      const vector = await this.embedder.embed(query, signal);
      const currentConversation = request.execution.origin.kind === "interactive" ? request.execution.origin.conversationId : undefined;
      // The current conversation is excluded. Do not impose an age cutoff here:
      // `/new` intentionally starts a new conversation, and a cutoff would
      // make the just-archived conversation disappear for the next 48 hours.
      const hits = await this.search.semanticSearch(vector, this.embedder.model, this.options.limit ?? 5, request.execution.authority.visibility, { ...(currentConversation ? { excludeConversationId: currentConversation } : {}), minSimilarity: this.options.minSimilarity ?? 0.55 });
      if (!hits.length) return [];
      const content = hits.map(hit => `- [conversation=${hit.conversationId}; turn=${hit.turnId}; similarity=${hit.semanticScore?.toFixed(3)}] ${hit.text}`).join("\n");
      return [{ id: "context.semantic_recall:query", providerId: this.id, role: this.role, content: `<recalled-memories trust="untrusted-data">\n${content}\n</recalled-memories>`, source: { kind: "semantic-search", ref: `query:${request.runId}` }, influence: "information" as const, instructionAuthority: "none" as const }];
    } catch (error) {
      if (request.signal?.aborted) throw error;
      try { this.logger.write({ level: "warn", event: "embedding.recall.degraded", message: "Semantic recall failed; continuing without recalled context", occurredAt: this.now().toISOString(), runId: request.runId, data: { model: this.embedder.model, errorName: error instanceof Error ? error.name : "NonErrorThrown" } }); } catch { /* Optional recall remains available when logging fails. */ }
      return [];
    }
  }
}
