import type { ConversationSearch, EmbeddingProjection, SearchHit } from "@umiro/core/search";
import type { VisibilityScope } from "@umiro/core/authorization";
import { ExecutionStoreConflictError } from "@umiro/core/ports";
import { NOOP_LOGGER, type StructuredLogger } from "@umiro/core/observability";
import { createHash } from "node:crypto";

export interface TextEmbedder {
  readonly model: string;
  embed(text: string, signal?: AbortSignal): Promise<readonly number[]>;
  embedMany?(texts: readonly string[], signal?: AbortSignal): Promise<readonly (readonly number[])[]>;
  /** Returns a low-priority view that shares the same provider request budget. */
  forBackground?(): TextEmbedder;
}

interface RateLimitScheduler {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemScheduler: RateLimitScheduler = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout),
};

type PendingEmbeddingRequest = {
  readonly priority: "foreground" | "background";
  readonly run: () => Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly signal?: AbortSignal;
  readonly abort: () => void;
};

/** Serializes all calls to one provider budget and lets interactive recall jump
 * ahead of queued background projection work. A batch consumes one request. */
export class RateLimitedTextEmbedder implements TextEmbedder {
  readonly model: string;
  private readonly intervalMs: number;
  private readonly queue: PendingEmbeddingRequest[] = [];
  private active = false;
  private lastStartedAt: number | undefined;
  private timer: unknown;

  constructor(private readonly inner: TextEmbedder, requestsPerMinute: number, private readonly scheduler: RateLimitScheduler = systemScheduler) {
    if (!Number.isSafeInteger(requestsPerMinute) || requestsPerMinute < 1 || requestsPerMinute > 600) throw new TypeError("embedding.requestsPerMinute must be between 1 and 600");
    this.model = inner.model;
    this.intervalMs = 60_000 / requestsPerMinute;
  }

  embed(text: string, signal?: AbortSignal): Promise<readonly number[]> { return this.enqueue(() => this.inner.embed(text, signal), "foreground", signal); }
  embedMany(texts: readonly string[], signal?: AbortSignal): Promise<readonly (readonly number[])[]> {
    if (!texts.length) return Promise.resolve([]);
    return this.inner.embedMany
      ? this.enqueue(() => this.inner.embedMany!(texts, signal), "foreground", signal)
      : Promise.all(texts.map(text => this.embed(text, signal)));
  }
  forBackground(): TextEmbedder {
    return {
      model: this.model,
      embed: (text, signal) => this.enqueue(() => this.inner.embed(text, signal), "background", signal),
      ...(this.inner.embedMany ? { embedMany: (texts: readonly string[], signal?: AbortSignal) => texts.length ? this.enqueue(() => this.inner.embedMany!(texts, signal), "background", signal) : Promise.resolve([]) } : {}),
    };
  }

  private enqueue<T>(run: () => Promise<T>, priority: "foreground" | "background", signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("embedding request aborted"));
    return new Promise<T>((resolve, reject) => {
      const request: PendingEmbeddingRequest = {
        priority,
        run,
        resolve: value => resolve(value as T),
        reject,
        ...(signal ? { signal } : {}),
        abort: () => {
          const index = this.queue.indexOf(request);
          if (index < 0) return;
          this.queue.splice(index, 1);
          reject(signal?.reason ?? new Error("embedding request aborted"));
          if (!this.queue.length && this.timer !== undefined) { this.scheduler.clearTimeout(this.timer); this.timer = undefined; }
        },
      };
      signal?.addEventListener("abort", request.abort, { once: true });
      this.queue.push(request);
      this.schedule();
    });
  }

  private schedule(): void {
    if (this.active || this.timer !== undefined || !this.queue.length) return;
    const delay = this.lastStartedAt === undefined ? 0 : Math.max(0, this.intervalMs - (this.scheduler.now() - this.lastStartedAt));
    if (delay > 0) {
      this.timer = this.scheduler.setTimeout(() => { this.timer = undefined; this.schedule(); }, delay);
      return;
    }
    const foreground = this.queue.findIndex(request => request.priority === "foreground");
    const [request] = this.queue.splice(foreground >= 0 ? foreground : 0, 1);
    if (!request) return;
    request.signal?.removeEventListener("abort", request.abort);
    this.active = true;
    this.lastStartedAt = this.scheduler.now();
    void request.run().then(request.resolve, request.reject).finally(() => { this.active = false; this.schedule(); });
  }
}

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
    return (await this.request(text, signal))[0]!;
  }
  async embedMany(texts: readonly string[], signal?: AbortSignal): Promise<readonly (readonly number[])[]> {
    if (!texts.length) return [];
    return this.request(texts, signal);
  }
  private async request(input: string | readonly string[], signal?: AbortSignal): Promise<readonly (readonly number[])[]> {
    const response = await this.fetcher(`${this.baseUrl.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      signal: signal ?? AbortSignal.timeout(30_000),
      headers: { "content-type": "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify({ model: this.apiModel, input }),
    });
    if (!response.ok) throw new Error(`embedding API failed with status ${response.status}`);
    const data = await response.json() as { data?: Array<{ index?: unknown; embedding?: unknown }> };
    if (!Array.isArray(data.data)) throw new Error("embedding API returned no vectors");
    const expected = typeof input === "string" ? 1 : input.length;
    const ordered = [...data.data].sort((left, right) => (typeof left.index === "number" ? left.index : 0) - (typeof right.index === "number" ? right.index : 0));
    if (ordered.length !== expected) throw new Error(`embedding API returned ${ordered.length} vectors for ${expected} inputs`);
    return ordered.map(item => embeddingVector(item.embedding));
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
      if (jobs.length && this.embedder.embedMany) {
        let vectors: readonly (readonly number[])[];
        try { vectors = await this.embedder.embedMany(jobs.map(job => job.text), signal); }
        catch (error) {
          for (const job of jobs) await this.fail(job, error);
          return 0;
        }
        if (vectors.length !== jobs.length) {
          const error = new Error(`embedder returned ${vectors.length} vectors for ${jobs.length} jobs`);
          for (const job of jobs) await this.fail(job, error);
          return 0;
        }
        for (let index = 0; index < jobs.length; index++) {
          const job = jobs[index]!;
          try { await this.store.completeEmbeddingJob(job.documentKey, job.contentHash, this.embedder.model, vectors[index]!, new Date().toISOString()); completed++; }
          catch (error) { await this.fail(job, error); }
        }
        return completed;
      }
      for (const job of jobs) {
        try { const vector = await this.embedder.embed(job.text, signal); await this.store.completeEmbeddingJob(job.documentKey, job.contentHash, this.embedder.model, vector, new Date().toISOString()); completed++; }
        catch (error) { await this.fail(job, error); }
      }
      return completed;
    } finally { this.running = false; }
  }
  private async fail(job: { readonly documentKey: string; readonly contentHash: string; readonly attempts: number }, error: unknown): Promise<void> {
    const delay = Math.min(3_600_000, 15_000 * 2 ** Math.max(0, job.attempts - 1));
    report(this.logger, { level: "warn", event: "embedding.job.failed", message: "Embedding job failed and will be retried", occurredAt: new Date().toISOString(), data: { model: this.embedder.model, documentKey: job.documentKey, attempts: job.attempts, retryDelayMs: delay, errorName: errorName(error) } });
    try {
      await this.store.failEmbeddingJob(job.documentKey, job.contentHash, `Embedding request failed (${errorName(error)})`, new Date(Date.now() + delay).toISOString(), new Date().toISOString());
    } catch (failure) {
      // A newer projection may have replaced this job while the provider call
      // was in flight. Its fresh pending job owns the document now; the stale
      // worker must not abort the whole background cycle trying to update it.
      if (!(failure instanceof ExecutionStoreConflictError)) throw failure;
    }
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
