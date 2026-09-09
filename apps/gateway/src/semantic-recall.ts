import type { ContextProvider } from "@umiro/core/context";
import type { EmbeddingProjection } from "@umiro/core/search";
import type { TextEmbedder } from "./embedding-worker.js";

export class SemanticRecallProvider implements ContextProvider {
  readonly id = "context.semantic_recall";
  readonly role = "recalled-memories";
  readonly priority = 800;
  constructor(private readonly search: EmbeddingProjection, private readonly embedder: TextEmbedder, private readonly now = () => new Date()) {}
  async load(request: Parameters<ContextProvider["load"]>[0]) {
    const query = request.prompt.trim(); if (!query) return [];
    const vector = await this.embedder.embed(query, request.signal);
    const currentConversation = request.execution.origin.kind === "interactive" ? request.execution.origin.conversationId : undefined;
    const beforeCreatedAt = new Date(this.now().getTime() - 2 * 86_400_000).toISOString();
    const hits = await this.search.semanticSearch(vector, this.embedder.model, 5, request.execution.authority.visibility, { ...(currentConversation ? { excludeConversationId: currentConversation } : {}), beforeCreatedAt, minSimilarity: 0.68 });
    if (!hits.length) return [];
    const content = hits.map(hit => `- [conversation=${hit.conversationId}; turn=${hit.turnId}; similarity=${hit.semanticScore?.toFixed(3)}] ${hit.text}`).join("\n");
    return [{ id: "context.semantic_recall:query", providerId: this.id, role: this.role, content: `<recalled-memories trust="untrusted-data">\n${content}\n</recalled-memories>`, source: { kind: "semantic-search", ref: `query:${request.runId}` }, influence: "information" as const, instructionAuthority: "none" as const }];
  }
}
