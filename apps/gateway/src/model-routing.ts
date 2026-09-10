import type { ModelPort, ModelRequest, ModelResponse } from "@umiro/core";

export type OpenAIProtocol = "openai_responses" | "openai_chat_completions";

export function parseOpenAIProtocol(value: unknown, label = "protocol"): OpenAIProtocol {
  if (value === undefined) return "openai_responses";
  if (value === "openai_responses" || value === "openai_chat_completions") return value;
  throw new TypeError(`${label} must be openai_responses or openai_chat_completions`);
}

export class OpenAIProtocolRouter implements ModelPort {
  constructor(
    private readonly responses: ModelPort,
    private readonly chatCompletions: ModelPort,
    private readonly protocolsByModel: ReadonlyMap<string, OpenAIProtocol>,
    private readonly defaultProtocol: OpenAIProtocol,
  ) {}

  generate(request: ModelRequest): Promise<ModelResponse> {
    const protocol = this.protocolsByModel.get(request.model) ?? this.defaultProtocol;
    return (protocol === "openai_chat_completions" ? this.chatCompletions : this.responses).generate(request);
  }
}

export function modelProtocolMap(entries: readonly { readonly model: string; readonly protocol: OpenAIProtocol }[]): ReadonlyMap<string, OpenAIProtocol> {
  const result = new Map<string, OpenAIProtocol>();
  for (const entry of entries) {
    const existing = result.get(entry.model);
    if (existing && existing !== entry.protocol) throw new TypeError(`model ${entry.model} is assigned to conflicting protocols`);
    result.set(entry.model, entry.protocol);
  }
  return result;
}
