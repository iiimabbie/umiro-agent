import { GeminiEmbedder, OpenAICompatibleEmbedder, type TextEmbedder } from "./embedding-worker.js";

export type EmbeddingConfig =
  | { readonly provider: "disabled" }
  | { readonly provider: "gemini"; readonly model: string; readonly apiKeyEnv?: string }
  | { readonly provider: "openai-compatible"; readonly model: string; readonly baseUrl: string; readonly apiKeyEnv?: string };

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
  const model = requiredString(config.model, "embedding.model");
  if (provider === "gemini") {
    const apiKeyEnv = config.apiKeyEnv === undefined ? "GOOGLE_API_KEY" : requiredString(config.apiKeyEnv, "embedding.apiKeyEnv");
    const apiKey = environment[apiKeyEnv]?.trim();
    if (!apiKey) throw new Error(`embedding credential environment variable is not set: ${apiKeyEnv}`);
    return new GeminiEmbedder(model, apiKey);
  }
  if (provider === "openai-compatible") {
    return new OpenAICompatibleEmbedder(model, requiredString(config.baseUrl, "embedding.baseUrl"), optionalEnvironmentKey(config, environment));
  }
  throw new TypeError(`unsupported embedding provider: ${provider}`);
}
