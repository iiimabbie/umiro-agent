import type {
  ModelContent,
  ModelFinishReason,
  ModelMessage,
  ModelPort,
  ModelRequest,
  ModelResponse,
  ModelToolCall,
  ReasoningEffort,
} from "@umiro/core/model";
import type { OpenAIConnectionConfig } from "./config.js";
import { OpenAIRequestError } from "./errors.js";
import { postOpenAIJson, postOpenAIResponse } from "./http.js";
import { parseToolCall } from "./tool-calls.js";

interface Annotation { type?: string; url?: string; title?: string }
interface ContentItem { type?: string; text?: string; annotations?: Annotation[] }
interface OutputItem { type?: string; call_id?: unknown; name?: unknown; arguments?: unknown; content?: ContentItem[] }
interface ResponsesPayload {
  id?: string;
  error?: unknown;
  status?: string;
  incomplete_details?: { reason?: string };
  output?: OutputItem[];
  output_text?: string;
  usage?: { input_tokens?: number; output_tokens?: number; output_tokens_details?: { reasoning_tokens?: number } };
}

export interface ResponsesWebSearchResult {
  readonly text: string;
  readonly sources: readonly { readonly title?: string; readonly url: string }[];
  readonly responseId?: string;
}

function inputContent(content: ModelContent): Array<Record<string, unknown>> {
  if (typeof content === "string") return [{ type: "input_text", text: content }];
  return content.map(part => {
    if (part.type === "text") return { type: "input_text", text: part.text };
    if (part.type === "file") return { type: "input_file", filename: part.filename, file_data: part.data };
    return { type: "input_image", image_url: part.url, ...(part.detail ? { detail: part.detail } : {}) };
  });
}

function messagesToInput(messages: readonly ModelMessage[]): { instructions?: string; input: Array<Record<string, unknown>> } {
  const instructions = messages
    .filter((message): message is Extract<ModelMessage, { role: "system" }> => message.role === "system")
    .map(message => message.content)
    .join("\n\n");
  const input: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user") input.push({ role: "user", content: inputContent(message.content) });
    else if (message.role === "tool") input.push({ type: "function_call_output", call_id: message.toolCallId, output: message.content });
    else {
      if (message.content) input.push({ role: "assistant", content: [{ type: "output_text", text: message.content }] });
      for (const call of message.toolCalls ?? []) {
        input.push({ type: "function_call", call_id: call.id, name: call.name, arguments: JSON.stringify(call.input) });
      }
    }
  }
  return { ...(instructions ? { instructions } : {}), input };
}

export function buildOpenAIResponsesBody(request: ModelRequest): Record<string, unknown> {
  const reasoningEffort = request.reasoningEffort ?? "default";
  return {
    model: request.model,
    ...messagesToInput(request.messages),
    max_output_tokens: request.maxOutputTokens ?? 8192,
    ...(reasoningEffort !== "default" ? { reasoning: { effort: reasoningEffort } } : {}),
    ...(request.tools?.length ? {
      tools: request.tools.map(tool => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.parameters })),
    } : {}),
    ...(request.onTextDelta ? { stream: true } : {}),
  };
}

async function streamedResponses(request: ModelRequest, config: OpenAIConnectionConfig): Promise<ResponsesPayload> {
  const response = await postOpenAIResponse({ config, path: "responses", body: buildOpenAIResponsesBody(request), label: "OpenAI Responses", ...(request.signal ? { signal: request.signal } : {}) });
  if (!response.body) throw new OpenAIRequestError("OpenAI Responses stream has no body", "invalid_response", false, response.status);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let completed: ResponsesPayload | undefined;
  const consume = async (block: string): Promise<void> => {
    const data = block.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") return;
    let event: { type?: string; delta?: unknown; response?: ResponsesPayload; error?: unknown };
    try { event = JSON.parse(data) as typeof event; } catch (error) { throw new OpenAIRequestError("OpenAI Responses stream returned invalid JSON", "invalid_response", false, response.status, { cause: error }); }
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") await request.onTextDelta?.(event.delta);
    if (event.type === "response.completed" && event.response) completed = event.response;
    if (event.type === "response.failed") throw new OpenAIRequestError(`OpenAI Responses stream failed: ${JSON.stringify(event.error ?? event.response?.error ?? {}).slice(0, 2_000)}`, "upstream", false);
  };
  while (true) {
    const { value, done } = await reader.read();
    buffer += value ?? "";
    let boundary: number;
    while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)![0];
      const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + separator.length);
      await consume(block);
    }
    if (done) break;
  }
  if (buffer.trim()) await consume(buffer);
  if (!completed) throw new OpenAIRequestError("OpenAI Responses stream ended without response.completed", "invalid_response", false, response.status);
  return completed;
}

export function responsesOutputText(response: ResponsesPayload): string {
  if (typeof response.output_text === "string" && response.output_text.trim()) return response.output_text.trim();
  return (response.output ?? []).flatMap(item => item.type === "message" ? item.content ?? [] : [])
    .filter(item => item.type === "output_text" && typeof item.text === "string")
    .map(item => item.text!.trim()).filter(Boolean).join("\n");
}

export function normalizeResponsesToolCalls(output: OutputItem[] | undefined): ModelToolCall[] {
  if (!Array.isArray(output)) return [];
  return output.flatMap((item, index) => item.type === "function_call"
    ? [parseToolCall({ id: item.call_id, name: item.name, arguments: item.arguments }, index)]
    : []);
}

export function normalizeResponsesFinishReason(response: ResponsesPayload, toolCalls: readonly ModelToolCall[]): ModelFinishReason {
  if (toolCalls.length > 0) return "tool_calls";
  if (response.status === "incomplete") {
    if (response.incomplete_details?.reason === "max_output_tokens") return "length";
    if (response.incomplete_details?.reason === "content_filter") return "content_filter";
    return "unknown";
  }
  return response.status === undefined || response.status === "completed" ? "stop" : "unknown";
}

function responseSources(response: ResponsesPayload): ResponsesWebSearchResult["sources"] {
  const unique = new Map<string, { title?: string; url: string }>();
  for (const item of response.output ?? []) for (const content of item.content ?? []) for (const annotation of content.annotations ?? []) {
    if (annotation.type === "url_citation" && typeof annotation.url === "string" && annotation.url) {
      unique.set(annotation.url, { ...(annotation.title ? { title: annotation.title } : {}), url: annotation.url });
    }
  }
  return [...unique.values()];
}

function assertResponsesPayload(raw: ResponsesPayload, label: string): void {
  if (raw.error) throw new OpenAIRequestError(`${label} failed: ${JSON.stringify(raw.error).slice(0, 2_000)}`, "upstream", false);
}

export class OpenAIResponsesModel implements ModelPort {
  constructor(private readonly config: OpenAIConnectionConfig) {}

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const raw = request.onTextDelta ? await streamedResponses(request, this.config) : await postOpenAIJson<ResponsesPayload>({
      config: this.config,
      path: "responses",
      body: buildOpenAIResponsesBody(request),
      label: "OpenAI Responses",
      ...(request.signal ? { signal: request.signal } : {}),
    });
    assertResponsesPayload(raw, "OpenAI Responses");
    const text = responsesOutputText(raw);
    const toolCalls = normalizeResponsesToolCalls(raw.output);
    if (!text && toolCalls.length === 0 && !(raw.output ?? []).some(item => item.type === "message")) {
      throw new OpenAIRequestError("OpenAI Responses returned no assistant output", "invalid_response", false);
    }
    return {
      text,
      toolCalls,
      finishReason: normalizeResponsesFinishReason(raw, toolCalls),
      usage: {
        inputTokens: raw.usage?.input_tokens ?? 0,
        outputTokens: raw.usage?.output_tokens ?? 0,
        reasoningTokens: raw.usage?.output_tokens_details?.reasoning_tokens ?? 0,
      },
      assistantMessage: { role: "assistant", content: text || null, ...(toolCalls.length ? { toolCalls } : {}) },
      ...(raw.id ? { providerRequestId: raw.id } : {}),
    };
  }
}

export async function callResponsesWebSearch(input: {
  readonly config: OpenAIConnectionConfig;
  readonly model: string;
  readonly query: string;
  readonly maxOutputTokens?: number;
  readonly reasoningEffort?: ReasoningEffort;
  readonly signal?: AbortSignal;
}): Promise<ResponsesWebSearchResult> {
  const raw = await postOpenAIJson<ResponsesPayload>({
    config: input.config,
    path: "responses",
    label: "OpenAI Responses web search",
    body: {
      model: input.model,
      input: input.query,
      tools: [{ type: "web_search" }],
      max_output_tokens: input.maxOutputTokens ?? 2048,
      ...(input.reasoningEffort && input.reasoningEffort !== "default" ? { reasoning: { effort: input.reasoningEffort } } : {}),
    },
    ...(input.signal ? { signal: input.signal } : {}),
  });
  assertResponsesPayload(raw, "OpenAI Responses web search");
  const text = responsesOutputText(raw);
  if (!text) throw new OpenAIRequestError("OpenAI Responses web search returned no output text", "invalid_response", false);
  return { text, sources: responseSources(raw), ...(raw.id ? { responseId: raw.id } : {}) };
}
