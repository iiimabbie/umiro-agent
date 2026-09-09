import type { ConversationSearch, EmbeddingProjection, SearchHit } from "@umiro/core/search";
import type { VisibilityScope } from "@umiro/core/authorization";

export interface TextEmbedder { readonly model: string; embed(text: string, signal?: AbortSignal): Promise<readonly number[]> }

export class GeminiEmbedder implements TextEmbedder {
  constructor(readonly model: string, private readonly apiKey: string) {}
  async embed(text: string, signal?: AbortSignal): Promise<readonly number[]> {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:embedContent?key=${encodeURIComponent(this.apiKey)}`, {
      method: "POST", signal: signal ?? AbortSignal.timeout(30_000), headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: `models/${this.model}`, content: { parts: [{ text }] } }),
    });
    if (!response.ok) throw new Error(`embedding API failed with status ${response.status}`);
    const data = await response.json() as { embedding?: { values?: unknown } };
    if (!Array.isArray(data.embedding?.values) || !data.embedding.values.every(value => typeof value === "number" && Number.isFinite(value))) throw new Error("embedding API returned an invalid vector");
    return data.embedding.values as number[];
  }
}

export class EmbeddingWorker {
  private timer: NodeJS.Timeout | undefined; private running = false;
  constructor(private readonly store: EmbeddingProjection, private readonly embedder: TextEmbedder, private readonly intervalMs = 15_000) {}
  start(): void { if (this.timer) return; void this.drain(); this.timer = setInterval(() => void this.drain(), this.intervalMs); this.timer.unref(); }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  async drain(signal?: AbortSignal): Promise<number> {
    if (this.running) return 0; this.running = true; let completed = 0;
    try {
      const now = new Date(); const stale = new Date(now.getTime() - 5 * 60_000).toISOString();
      const jobs = await this.store.claimEmbeddingJobs(20, now.toISOString(), stale);
      for (const job of jobs) {
        try { const vector = await this.embedder.embed(job.text, signal); await this.store.completeEmbeddingJob(job.turnId, job.contentHash, this.embedder.model, vector, new Date().toISOString()); completed++; }
        catch (error) { const delay = Math.min(3_600_000, 15_000 * 2 ** Math.max(0, job.attempts - 1)); await this.store.failEmbeddingJob(job.turnId, job.contentHash, error instanceof Error ? error.message : String(error), new Date(Date.now() + delay).toISOString(), new Date().toISOString()); }
      }
      return completed;
    } finally { this.running = false; }
  }
}

export class HybridConversationSearch implements ConversationSearch {
  constructor(private readonly store: ConversationSearch & EmbeddingProjection, private readonly embedder?: TextEmbedder) {}
  async search(query: string, limit: number, visibility: VisibilityScope): Promise<readonly SearchHit[]> {
    const lexical = await this.store.search(query, limit, visibility);
    if (!this.embedder) return lexical;
    let semantic: readonly SearchHit[] = [];
    try { semantic = await this.store.semanticSearch(await this.embedder.embed(query), this.embedder.model, limit, visibility); } catch { return lexical; }
    const byTurn = new Map<string, { hit: SearchHit; score: number }>();
    lexical.forEach((hit, index) => byTurn.set(hit.turnId, { hit, score: 1 / (60 + index) }));
    semantic.forEach((hit, index) => { const previous = byTurn.get(hit.turnId); byTurn.set(hit.turnId, { hit: previous?.hit ?? hit, score: (previous?.score ?? 0) + 1 / (60 + index) }); });
    return [...byTurn.values()].sort((left, right) => right.score - left.score).slice(0, limit).map(item => ({ ...item.hit, rank: -item.score }));
  }
  rebuildSearchProjection(): Promise<void> { return this.store.rebuildSearchProjection(); }
}
