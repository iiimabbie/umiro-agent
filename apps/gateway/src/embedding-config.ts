import { GeminiEmbedder, OpenAICompatibleEmbedder, RateLimitedTextEmbedder, type TextEmbedder } from "./embedding-worker.js";

export type EmbeddingConfig =
  | { readonly provider: "disabled" }
  | { readonly provider: "gemini"; readonly model: string; readonly apiKeyEnv?: string; readonly recallLimit?: number; readonly minSimilarity?: number; readonly requestsPerMinute?: number }
  | { readonly provider: "openai-compatible"; readonly model: string; readonly baseUrl: string; readonly apiKeyEnv?: string; readonly recallLimit?: number; readonly minSimilarity?: number; readonly requestsPerMinute?: number };

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  return value.trim();
}

function optionalEnvironmentKey(config: Record<string, unknown>, environment: NodeJS.ProcessEnv): string | undefined {
  if (config.apiKeyEnv === undefined) return undefined;
  const variable = requiredString(config.apiKeyEnv, "embedding.apiKeyEnv");
  const value = environment[variable]?.trim();
  if (!value) throw new Error(`embedding credential environment variable is not set: ${variable}`);
  return value;
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
  let embedder: TextEmbedder;
  if (provider === "gemini") {
    const apiKeyEnv = config.apiKeyEnv === undefined ? "GOOGLE_API_KEY" : requiredString(config.apiKeyEnv, "embedding.apiKeyEnv");
    const apiKey = environment[apiKeyEnv]?.trim();
    if (!apiKey) throw new Error(`embedding credential environment variable is not set: ${apiKeyEnv}`);
    embedder = new GeminiEmbedder(model, apiKey);
  } else if (provider === "openai-compatible") {
    embedder = new OpenAICompatibleEmbedder(model, requiredString(config.baseUrl, "embedding.baseUrl"), optionalEnvironmentKey(config, environment));
  } else {
    throw new TypeError(`unsupported embedding provider: ${provider}`);
  }
  return config.requestsPerMinute === undefined ? embedder : new RateLimitedTextEmbedder(embedder, Number(config.requestsPerMinute));
}
