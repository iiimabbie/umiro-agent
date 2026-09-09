import type { JsonObject, JsonValue, Operation } from "@umiro/core";

const SECRET_KEY = /(?:authorization|cookie|password|secret|token|api[_-]?key)/i;

function redact(value: JsonValue, key?: string): JsonValue {
  if (key && SECRET_KEY.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map(item => redact(item));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name)]));
  return value;
}

export function approvalDetails(operation: Pick<Operation, "input">, maxCharacters = 1_200): string {
  const serialized = JSON.stringify(redact(operation.input as JsonObject), null, 2);
  const bounded = serialized.length <= maxCharacters ? serialized : `${serialized.slice(0, Math.max(0, maxCharacters - 15))}\n…[truncated]`;
  return `\`\`\`json\n${bounded}\n\`\`\``;
}
