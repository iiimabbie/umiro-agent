import type { ModelToolCall } from "@umiro/core/model";

export function parseToolCall(input: {
  readonly id: unknown;
  readonly name: unknown;
  readonly arguments: unknown;
}, index: number): ModelToolCall {
  const id = typeof input.id === "string" && input.id ? input.id : `call_missing_${index}`;
  const name = typeof input.name === "string" ? input.name : "";
  const argumentText = typeof input.arguments === "string" ? input.arguments : "{}";
  if (!name) return { id, name: "", input: {}, argumentError: "function name is missing" };
  if (!argumentText.trim()) return { id, name, input: {} };
  try {
    const parsed = JSON.parse(argumentText) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { id, name, input: {}, argumentError: "function arguments must decode to a JSON object" };
    }
    return { id, name, input: parsed as Record<string, unknown> };
  } catch (error) {
    return { id, name, input: {}, argumentError: `malformed function arguments: ${(error as Error).message}` };
  }
}
