import { HEURISTIC_CONTEXT_TOKEN_ESTIMATOR } from "../context/tokens.js";
import type { ModelContent, ModelFunctionTool, ModelMessage } from "./contract.js";

/** Fixed planning costs for binary media. Raw URLs/base64 are transport
 * payloads, not prompt text, and must never make a context budget collapse. */
export const MODEL_IMAGE_PART_TOKEN_COST = 256;
export const MODEL_FILE_PART_TOKEN_COST = 512;

function normalizedContent(content: ModelContent | null): { readonly value: unknown; readonly mediaTokens: number } {
  if (content === null) return { value: null, mediaTokens: 0 };
  if (typeof content === "string") return { value: content, mediaTokens: 0 };
  let mediaTokens = 0;
  const value = content.map(part => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "image") {
      mediaTokens += MODEL_IMAGE_PART_TOKEN_COST;
      return { type: "image", detail: part.detail ?? "auto" };
    }
    mediaTokens += MODEL_FILE_PART_TOKEN_COST;
    return { type: "file", filename: part.filename };
  });
  return { value, mediaTokens };
}

/** Estimates a model message while excluding unbounded image/file payloads. */
export function estimateModelMessageTokens(message: ModelMessage): number {
  if (message.role === "tool") return HEURISTIC_CONTEXT_TOKEN_ESTIMATOR.estimate(JSON.stringify(message));
  if (message.role === "assistant" && message.content === null) return HEURISTIC_CONTEXT_TOKEN_ESTIMATOR.estimate(JSON.stringify(message));
  const normalized = normalizedContent(message.content);
  return HEURISTIC_CONTEXT_TOKEN_ESTIMATOR.estimate(JSON.stringify({ ...message, content: normalized.value })) + normalized.mediaTokens;
}

/** Estimates the complete request without counting raw binary URL/data payloads. */
export function estimateModelRequestTokens(messages: readonly ModelMessage[], tools: readonly ModelFunctionTool[] = []): number {
  const messageCost = messages.reduce((total, message) => total + estimateModelMessageTokens(message), 0);
  const toolCost = tools.length ? HEURISTIC_CONTEXT_TOKEN_ESTIMATOR.estimate(JSON.stringify(tools)) : 0;
  return messageCost + toolCost;
}
