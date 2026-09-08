export type ReasoningEffort = "default" | "low" | "medium" | "high" | "xhigh";

export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Reasoning tokens are included in outputTokens and must not be added twice. */
  readonly reasoningTokens: number;
}

export type ModelTextPart = { readonly type: "text"; readonly text: string };
export type ModelImagePart = {
  readonly type: "image";
  readonly url: string;
  readonly detail?: "auto" | "low" | "high";
};
export type ModelFilePart = { readonly type: "file"; readonly data: string; readonly filename: string };
export type ModelContent = string | readonly (ModelTextPart | ModelImagePart | ModelFilePart)[];

export interface ModelFunctionTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

export interface ModelToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
  /** Malformed arguments remain non-executable instead of degrading to an empty object. */
  readonly argumentError?: string;
}

export type ModelMessage =
  | { readonly role: "system"; readonly content: string }
  | { readonly role: "user"; readonly content: ModelContent }
  | { readonly role: "assistant"; readonly content: string | null; readonly toolCalls?: readonly ModelToolCall[] }
  | { readonly role: "tool"; readonly toolCallId: string; readonly content: string };

export type ModelFinishReason = "stop" | "tool_calls" | "length" | "content_filter" | "unknown";

/** Runtime-selected values only. Provider credentials are never part of this request. */
export interface ModelRequest {
  readonly model: string;
  readonly messages: readonly ModelMessage[];
  readonly tools?: readonly ModelFunctionTool[];
  readonly maxOutputTokens?: number;
  readonly reasoningEffort?: ReasoningEffort;
  readonly signal?: AbortSignal;
}

export interface ModelResponse {
  readonly text: string;
  readonly toolCalls: readonly ModelToolCall[];
  readonly finishReason: ModelFinishReason;
  readonly usage: ModelUsage;
  readonly assistantMessage: Extract<ModelMessage, { role: "assistant" }>;
  /** Provider request ID for audit correlation, when returned. */
  readonly providerRequestId?: string;
}

export interface ModelPort {
  generate(request: ModelRequest): Promise<ModelResponse>;
}
