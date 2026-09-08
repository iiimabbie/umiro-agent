import type { ModelPort } from "@umiro/core/model";
import {
  OpenAIChatCompletionsModel,
  type OpenAIConnectionConfig,
  OpenAIModelCatalog,
  OpenAIResponsesModel,
} from "@umiro/model-openai";

export type ModelProtocol = "openai_responses" | "openai_chat_completions";

export interface CliOptions {
  readonly prompt?: string;
  readonly model?: string;
  readonly protocol?: ModelProtocol;
}

export interface CliRuntime {
  readonly env: NodeJS.ProcessEnv;
  readonly stdinIsTTY: boolean;
  readonly readStdin: () => Promise<string>;
  readonly writeStdout: (text: string) => void;
  readonly writeStderr: (text: string) => void;
  readonly listModels?: (config: OpenAIConnectionConfig) => Promise<readonly string[]>;
  readonly createModel?: (protocol: ModelProtocol, config: OpenAIConnectionConfig) => ModelPort;
}

export class CliUsageError extends Error {}

function optionValue(args: readonly string[], index: number, name: string): { value: string; consumed: number } {
  const current = args[index]!;
  const inline = current.slice(name.length + 1);
  if (current.startsWith(`${name}=`)) {
    if (!inline) throw new CliUsageError(`${name} requires a value`);
    return { value: inline, consumed: 1 };
  }
  const next = args[index + 1];
  if (!next || next.startsWith("--")) throw new CliUsageError(`${name} requires a value`);
  return { value: next, consumed: 2 };
}

export function parseCliArgs(args: readonly string[]): CliOptions {
  let model: string | undefined;
  let protocol: ModelProtocol | undefined;
  const promptParts: string[] = [];

  for (let index = 0; index < args.length;) {
    const arg = args[index]!;
    if (arg === "--") {
      index += 1;
      continue;
    }
    if (arg === "--model" || arg.startsWith("--model=")) {
      const parsed = optionValue(args, index, "--model");
      model = parsed.value;
      index += parsed.consumed;
      continue;
    }
    if (arg === "--protocol" || arg.startsWith("--protocol=")) {
      const parsed = optionValue(args, index, "--protocol");
      if (parsed.value !== "openai_responses" && parsed.value !== "openai_chat_completions") {
        throw new CliUsageError(`unsupported protocol: ${parsed.value}`);
      }
      protocol = parsed.value;
      index += parsed.consumed;
      continue;
    }
    if (arg.startsWith("--")) throw new CliUsageError(`unknown option: ${arg}`);
    promptParts.push(arg);
    index += 1;
  }

  const prompt = promptParts.join(" ").trim();
  return {
    ...(prompt ? { prompt } : {}),
    ...(model ? { model } : {}),
    ...(protocol ? { protocol } : {}),
  };
}

function connectionConfig(env: NodeJS.ProcessEnv): OpenAIConnectionConfig {
  const baseUrl = env.LLM_BASE_URL?.trim();
  if (!baseUrl) throw new CliUsageError("LLM_BASE_URL is required");
  const apiKey = env.LLM_API_KEY?.trim();
  return {
    baseUrl,
    auth: apiKey ? "bearer" : "none",
    ...(apiKey ? { apiKey } : {}),
    timeoutMs: 120_000,
  };
}

async function selectModel(
  requested: string | undefined,
  config: OpenAIConnectionConfig,
  listModels: NonNullable<CliRuntime["listModels"]>,
): Promise<string> {
  if (requested) return requested;
  const models = await listModels(config);
  const selected = models.includes("gpt-5.6-terra") ? "gpt-5.6-terra" : models[0];
  if (!selected) throw new Error("model discovery returned no conversation models");
  return selected;
}

export async function runCli(args: readonly string[], runtime: CliRuntime): Promise<void> {
  const options = parseCliArgs(args);
  const prompt = options.prompt ?? (runtime.stdinIsTTY ? "" : (await runtime.readStdin()).trim());
  if (!prompt) throw new CliUsageError("prompt is required as arguments or stdin");

  const config = connectionConfig(runtime.env);
  const protocol = options.protocol
    ?? (runtime.env.LLM_PROTOCOL?.trim() as ModelProtocol | undefined)
    ?? "openai_responses";
  if (protocol !== "openai_responses" && protocol !== "openai_chat_completions") {
    throw new CliUsageError(`unsupported protocol: ${protocol}`);
  }

  const listModels = runtime.listModels
    ?? (value => new OpenAIModelCatalog(value).listConversationModels());
  const model = await selectModel(options.model ?? runtime.env.LLM_MODEL?.trim(), config, listModels);
  const createModel = runtime.createModel
    ?? ((selectedProtocol, value) => selectedProtocol === "openai_chat_completions"
      ? new OpenAIChatCompletionsModel(value)
      : new OpenAIResponsesModel(value));

  runtime.writeStderr(`model: ${model}\nprotocol: ${protocol}\n`);
  const response = await createModel(protocol, config).generate({
    model,
    messages: [{ role: "user", content: prompt }],
  });
  runtime.writeStdout(`${response.text}\n`);
}
