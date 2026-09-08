export type OpenAIAuthStrategy = "bearer" | "none";
export type ChatTokenLimitField = "max_completion_tokens" | "max_tokens";

export interface OpenAIRetryEvent {
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly endpoint: string;
  readonly status?: number;
  readonly category: "transport" | "http";
}

/** Runtime-only connection configuration. Never persist apiKey in a Run snapshot. */
export interface OpenAIConnectionConfig {
  readonly baseUrl: string;
  readonly auth?: OpenAIAuthStrategy;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly onRetry?: (event: OpenAIRetryEvent) => void;
}

export interface OpenAIChatConfig extends OpenAIConnectionConfig {
  readonly tokenLimitField?: ChatTokenLimitField;
}
