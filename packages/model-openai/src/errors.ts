export type OpenAIErrorCategory =
  | "authentication"
  | "rate_limit"
  | "timeout"
  | "transport"
  | "invalid_response"
  | "upstream";

export class OpenAIRequestError extends Error {
  constructor(
    message: string,
    readonly category: OpenAIErrorCategory,
    readonly retryable: boolean,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "OpenAIRequestError";
  }
}
