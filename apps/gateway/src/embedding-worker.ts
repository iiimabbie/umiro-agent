import type { ConversationSearch, EmbeddingProjection, SearchHit } from "@umiro/core/search";
import type { VisibilityScope } from "@umiro/core/authorization";
import { NOOP_LOGGER, type StructuredLogger } from "@umiro/core/observability";
import { createHash } from "node:crypto";

export interface TextEmbedder { readonly model: string; embed(text: string, signal?: AbortSignal): Promise<readonly number[]> }

type Fetcher = typeof fetch;

function report(logger: StructuredLogger, record: Parameters<StructuredLogger["write"]>[0]): void {
  try { logger.write(record); } catch { /* Observability must not alter execution behavior. */ }
}

function errorName(error: unknown): string { return error instanceof Error ? error.name : "NonErrorThrown"; }

function embeddingVector(data: unknown): readonly number[] {
  if (!Array.isArray(data) || !data.every(value => typeof value === "number" && Number.isFinite(value))) {
    throw new Error("embedding API returned an invalid vector");
  }
  return data;
}

export class GeminiEmbedder implements TextEmbedder {
  readonly model: string;
  constructor(private readonly apiModel: string, private readonly apiKey: string, private readonly fetcher: Fetcher = fetch) {
    this.model = `gemini:${apiModel}`;
  }
  async embed(text: string, signal?: AbortSignal): Promise<readonly number[]> {
    const response = await this.fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.apiModel)}:embedContent?key=${encodeURIComponent(this.apiKey)}`, {
      method: "POST", signal: signal ?? AbortSignal.timeout(30_000), headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: `models/${this.apiModel}`, content: { parts: [{ text }] } }),
    });
    if (!response.ok) throw new Error(`embedding API failed with status ${response.status}`);
    const data = await response.json() as { embedding?: { values?: unknown } };
    return embeddingVector(data.embedding?.values);
  }
}

export class OpenAICompatibleEmbedder implements TextEmbedder {
  readonly model: string;
  constructor(private readonly apiModel: string, private readonly baseUrl: string, private readonly apiKey?: string, private readonly fetcher: Fetcher = fetch) {
    const endpointIdentity = createHash("sha256").update(baseUrl).digest("hex").slice(0, 12);
    this.model = `openai-compatible:${endpointIdentity}:${apiModel}`;
  }
  async embed(text: string, signal?: AbortSignal): Promise<readonly number[]> {
    const response = await this.fetcher(`${this.baseUrl.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      signal: signal ?? AbortSignal.timeout(30_000),
      headers: { "content-type": "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify({ model: this.apiModel, input: text }),
    });
    if (!response.ok) throw new Error(`embedding API failed with status ${response.status}`);
    const data = await response.json() as { data?: Array<{ embedding?: unknown }> };
    return embeddingVector(data.data?.[0]?.embedding);
  }
}

export class EmbeddingWorker {
  private timer: NodeJS.Timeout | undefined; private running = false; private prepared = false;
  constructor(private readonly store: EmbeddingProjection, private readonly embedder: TextEmbedder, private readonly intervalMs = 15_000, private readonly logger: StructuredLogger = NOOP_LOGGER) {}
  start(): void { if (this.timer) return; this.drainInBackground(); this.timer = setInterval(() => this.drainInBackground(), this.intervalMs); this.timer.unref(); }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  private drainInBackground(): void {
    void this.drain().catch(error => report(this.logger, { level: "error", event: "embedding.worker.failed", message: "Embedding worker cycle failed", occurredAt: new Date().toISOString(), data: { model: this.embedder.model, errorName: errorName(error) } }));
  }
  async drain(signal?: AbortSignal): Promise<number> {
    if (this.running) return 0; this.running = true; let completed = 0;
    try {
      if (!this.prepared) { await this.store.prepareEmbeddingModel(this.embedder.model); this.prepared = true; }
      const now = new Date(); const stale = new Date(now.getTime() - 5 * 60_000).toISOString();
      const jobs = await this.store.claimEmbeddingJobs(20, now.toISOString(), stale);
      for (const job of jobs) {
        try { const vector = await this.embedder.embed(job.text, signal); await this.store.completeEmbeddingJob(job.turnId, job.contentHash, this.embedder.model, vector, new Date().toISOString()); completed++; }
        catch (error) {
          const delay = Math.min(3_600_000, 15_000 * 2 ** Math.max(0, job.attempts - 1));
          report(this.logger, { level: "warn", event: "embedding.job.failed", message: "Embedding job failed and will be retried", occurredAt: new Date().toISOString(), data: { model: this.embedder.model, turnId: job.turnId, attempts: job.attempts, retryDelayMs: delay, errorName: errorName(error) } });
          await this.store.failEmbeddingJob(job.turnId, job.contentHash, `Embedding request failed (${errorName(error)})`, new Date(Date.now() + delay).toISOString(), new Date().toISOString());
        }
      }
      return completed;
    } finally { this.running = false; }
  }
}

export class HybridConversationSearch implements ConversationSearch {
  constructor(private readonly store: ConversationSearch & EmbeddingProjection, private readonly embedder?: TextEmbedder, private readonly logger: StructuredLogger = NOOP_LOGGER) {}
  async search(query: string, limit: number, visibility: VisibilityScope): Promise<readonly SearchHit[]> {
    const lexical = await this.store.search(query, limit, visibility);
    if (!this.embedder) return lexical;
    let semantic: readonly SearchHit[] = [];
    try { semantic = await this.store.semanticSearch(await this.embedder.embed(query), this.embedder.model, limit, visibility); }
    catch (error) {
      report(this.logger, { level: "warn", event: "embedding.search.degraded", message: "Semantic search failed; returning full-text results", occurredAt: new Date().toISOString(), data: { model: this.embedder.model, errorName: errorName(error) } });
      return lexical;
    }
    const byTurn = new Map<string, { hit: SearchHit; score: number }>();
    lexical.forEach((hit, index) => byTurn.set(hit.turnId, { hit, score: 1 / (60 + index) }));
    semantic.forEach((hit, index) => { const previous = byTurn.get(hit.turnId); byTurn.set(hit.turnId, { hit: previous?.hit ?? hit, score: (previous?.score ?? 0) + 1 / (60 + index) }); });
    return [...byTurn.values()].sort((left, right) => right.score - left.score).slice(0, limit).map(item => ({ ...item.hit, rank: -item.score }));
  }
  rebuildSearchProjection(): Promise<void> { return this.store.rebuildSearchProjection(); }
}
