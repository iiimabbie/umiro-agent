import type {
  ModelContent,
  ModelFinishReason,
  ModelMessage,
  ModelPort,
  ModelRequest,
  ModelResponse,
  ModelToolCall,
} from "@umiro/core/model";
import type { OpenAIChatConfig } from "./config.js";
import { OpenAIRequestError } from "./errors.js";
import { postOpenAIJson } from "./http.js";
import { parseToolCall } from "./tool-calls.js";

interface OpenAIToolCall { id?: unknown; function?: { name?: unknown; arguments?: unknown } }
type OpenAIContent = string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } } | { type: "file"; file: { filename: string; file_data: string } }>;
type OpenAIMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: OpenAIContent }
  | { role: "assistant"; content: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }
  | { role: "tool"; tool_call_id: string; content: string };
interface ChatCompletionResponse {
  id?: string;
  choices?: Array<{ finish_reason?: unknown; message?: { content?: unknown; tool_calls?: unknown } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } };
}

export function normalizeChatContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(part => part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string"
    ? String((part as Record<string, unknown>).text)
    : "").join("");
}

export function normalizeChatFinishReason(value: unknown): ModelFinishReason {
  return value === "stop" || value === "tool_calls" || value === "length" || value === "content_filter" ? value : "unknown";
}

export function normalizeChatToolCalls(value: unknown): ModelToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw, index) => {
    if (!raw || typeof raw !== "object") return [];
    const call = raw as OpenAIToolCall;
    if (!call.function || typeof call.function !== "object") return [];
    return [parseToolCall({ id: call.id, name: call.function.name, arguments: call.function.arguments }, index)];
  });
}

function contentToWire(content: ModelContent): OpenAIContent {
  if (typeof content === "string") return content;
  return content.map(part => {
    if (part.type === "text") return part;
    if (part.type === "file") {
      if (!part.filename.toLowerCase().endsWith(".pdf") && !part.data.toLowerCase().startsWith("data:application/pdf;")) throw new OpenAIRequestError("OpenAI Chat Completions only supports direct PDF file input", "upstream", false);
      return { type: "file" as const, file: { filename: part.filename, file_data: part.data } };
    }
    return { type: "image_url" as const, image_url: { url: part.url, ...(part.detail ? { detail: part.detail } : {}) } };
  });
}

function messageToWire(message: ModelMessage): OpenAIMessage {
  if (message.role === "system") return message;
  if (message.role === "user") return { role: "user", content: contentToWire(message.content) };
  if (message.role === "tool") return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  return {
    role: "assistant",
    content: message.content,
    ...(message.toolCalls?.length ? {
      tool_calls: message.toolCalls.map(call => ({
        id: call.id,
        type: "function" as const,
        function: { name: call.name, arguments: JSON.stringify(call.input) },
      })),
    } : {}),
  };
}

export function buildOpenAIChatBody(request: ModelRequest, config: Pick<OpenAIChatConfig, "tokenLimitField"> = {}): Record<string, unknown> {
  const tokenLimitField = config.tokenLimitField ?? "max_completion_tokens";
  const reasoningEffort = request.reasoningEffort ?? "default";
  return {
    model: request.model,
    messages: request.messages.map(messageToWire),
    [tokenLimitField]: request.maxOutputTokens ?? 8192,
    ...(reasoningEffort !== "default" ? { reasoning_effort: reasoningEffort } : {}),
    ...(request.tools?.length ? { tools: request.tools.map(tool => ({ type: "function", function: tool })) } : {}),
  };
}

export class OpenAIChatCompletionsModel implements ModelPort {
  constructor(private config: OpenAIChatConfig) {}

  configure(config: OpenAIChatConfig): void { this.config = config; }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const raw = await postOpenAIJson<ChatCompletionResponse>({
      config: this.config,
      path: "chat/completions",
      body: buildOpenAIChatBody(request, this.config),
      label: "OpenAI Chat Completions",
      ...(request.signal ? { signal: request.signal } : {}),
    });
    const choice = raw.choices?.[0];
    if (!choice?.message) throw new OpenAIRequestError("OpenAI Chat Completions returned no assistant message", "invalid_response", false);
    const text = normalizeChatContent(choice.message.content);
    const toolCalls = normalizeChatToolCalls(choice.message.tool_calls);
    return {
      text,
      toolCalls,
      finishReason: normalizeChatFinishReason(choice.finish_reason),
      usage: {
        inputTokens: raw.usage?.prompt_tokens ?? 0,
        outputTokens: raw.usage?.completion_tokens ?? 0,
        reasoningTokens: raw.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
      },
      assistantMessage: { role: "assistant", content: text || null, ...(toolCalls.length ? { toolCalls } : {}) },
      ...(raw.id ? { providerRequestId: raw.id } : {}),
    };
  }
}
