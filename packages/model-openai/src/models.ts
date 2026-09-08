import type { OpenAIConnectionConfig } from "./config.js";
import { OpenAIRequestError } from "./errors.js";
import { openAIHeaders } from "./http.js";

const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const MEDIA_MODEL_SEGMENTS = new Set(["img", "image", "images", "video", "videos"]);

export function isMediaModel(id: string): boolean {
  return id.toLowerCase().split(/[^a-z0-9]+/).some(part => MEDIA_MODEL_SEGMENTS.has(part));
}

export function parseModelIds(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return [...new Set(data.flatMap(entry => {
    if (!entry || typeof entry !== "object") return [];
    const id = (entry as { id?: unknown }).id;
    return typeof id === "string" && id.trim() ? [id.trim()] : [];
  }))].sort((a, b) => a.localeCompare(b));
}

export class OpenAIModelCatalog {
  private cached?: { readonly expiresAt: number; readonly models: readonly string[] };
  private inFlight: Promise<readonly string[]> | undefined;

  constructor(
    private readonly config: OpenAIConnectionConfig,
    private readonly cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  ) {}

  async list(signal?: AbortSignal): Promise<readonly string[]> {
    if (this.cached && this.cached.expiresAt > Date.now()) return this.cached.models;
    if (this.inFlight) return this.inFlight;
    const task = this.fetch(signal).then(models => {
      this.cached = { expiresAt: Date.now() + this.cacheTtlMs, models };
      return models;
    }).finally(() => { this.inFlight = undefined; });
    this.inFlight = task;
    return task;
  }

  async listConversationModels(signal?: AbortSignal): Promise<readonly string[]> {
    const models = await this.list(signal);
    const conversational = models.filter(id => !isMediaModel(id));
    return conversational.length > 0 ? conversational : models;
  }

  private async fetch(signal?: AbortSignal): Promise<readonly string[]> {
    const endpoint = `${this.config.baseUrl.replace(/\/+$/, "")}/models`;
    const timeoutSignal = AbortSignal.timeout(Math.min(this.config.timeoutMs ?? 2_000, 10_000));
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    let response: Response;
    try {
      response = await fetch(endpoint, { method: "GET", headers: openAIHeaders(this.config), signal: requestSignal });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw new OpenAIRequestError(`OpenAI model discovery ${timeoutSignal.aborted ? "timed out" : "failed"}`, timeoutSignal.aborted ? "timeout" : "transport", true, undefined, { cause: error });
    }
    if (!response.ok) {
      throw new OpenAIRequestError(`OpenAI model discovery ${response.status}: ${(await response.text()).slice(0, 1_000)}`, "upstream", false, response.status);
    }
    let payload: unknown;
    try { payload = await response.json(); }
    catch (error) { throw new OpenAIRequestError("OpenAI model discovery returned invalid JSON", "invalid_response", false, response.status, { cause: error }); }
    const models = parseModelIds(payload);
    if (models.length === 0) throw new OpenAIRequestError("OpenAI model discovery returned no valid model IDs", "invalid_response", false);
    return models;
  }
}
