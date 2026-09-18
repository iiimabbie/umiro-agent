import { GeminiEmbedder, OpenAICompatibleEmbedder, RateLimitedTextEmbedder, type TextEmbedder } from "./embedding-worker.js";

export type EmbeddingConfig =
  | { readonly provider: "disabled" }
  | { readonly provider: "gemini"; readonly model: string; readonly recallLimit?: number; readonly minSimilarity?: number; readonly requestsPerMinute?: number }
  | { readonly provider: "openai-compatible"; readonly model: string; readonly baseUrl: string; readonly recallLimit?: number; readonly minSimilarity?: number; readonly requestsPerMinute?: number };

export const EMBEDDING_API_KEY_SECRET = "UMIRO_EMBEDDING_API_KEY";

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  return value.trim();
}

export function createConfiguredEmbedder(raw: unknown, environment: NodeJS.ProcessEnv = process.env): TextEmbedder | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("embedding config must be an object");
  const config = raw as Record<string, unknown>;
  const provider = requiredString(config.provider, "embedding.provider");
  if (provider === "disabled") return undefined;
  if (config.recallLimit !== undefined && (!Number.isSafeInteger(config.recallLimit) || Number(config.recallLimit) < 1 || Number(config.recallLimit) > 20)) throw new TypeError("embedding.recallLimit must be between 1 and 20");
  if (config.minSimilarity !== undefined && (typeof config.minSimilarity !== "number" || !Number.isFinite(config.minSimilarity) || config.minSimilarity < 0 || config.minSimilarity > 1)) throw new TypeError("embedding.minSimilarity must be between 0 and 1");
  if (config.requestsPerMinute !== undefined && (!Number.isSafeInteger(config.requestsPerMinute) || Number(config.requestsPerMinute) < 1 || Number(config.requestsPerMinute) > 600)) throw new TypeError("embedding.requestsPerMinute must be between 1 and 600");
  const model = requiredString(config.model, "embedding.model");
  const apiKey = environment[EMBEDDING_API_KEY_SECRET]?.trim();
  let embedder: TextEmbedder;
  if (provider === "gemini") {
    if (!apiKey) throw new Error("Embedding API key is not configured");
    embedder = new GeminiEmbedder(model, apiKey);
  } else if (provider === "openai-compatible") {
    embedder = new OpenAICompatibleEmbedder(model, requiredString(config.baseUrl, "embedding.baseUrl"), apiKey);
  } else {
    throw new TypeError(`unsupported embedding provider: ${provider}`);
  }
  return config.requestsPerMinute === undefined ? embedder : new RateLimitedTextEmbedder(embedder, Number(config.requestsPerMinute));
}
