import type { LogRecord, StructuredLogger } from "@umiro/core";

const CONTEXT_FIELDS = ["runId", "stepId", "operationId", "pluginId", "conversationId", "turnId", "correlationId"] as const;

function escapeControls(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, character => JSON.stringify(character).slice(1, -1)).replaceAll(String.fromCharCode(0x2028), "\\u2028").replaceAll(String.fromCharCode(0x2029), "\\u2029");
}

function formatValue(value: unknown): string {
  const serialized = JSON.stringify(value);
  return typeof value === "string" ? serialized : (serialized ?? String(value));
}

function formatLocalTimestamp(value: string): string {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) return escapeControls(value);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${timestamp.getFullYear()}-${pad(timestamp.getMonth() + 1)}-${pad(timestamp.getDate())} ${pad(timestamp.getHours())}:${pad(timestamp.getMinutes())}:${pad(timestamp.getSeconds())}`;
}

export function formatLogRecord(record: LogRecord): string {
  const fields = CONTEXT_FIELDS.filter(key => record[key] !== undefined).map(key => `${key}=${formatValue(record[key])}`);
  for (const key of Object.keys(record.data ?? {}).sort()) fields.push(`${escapeControls(key)}=${formatValue(record.data![key])}`);
  return `${formatLocalTimestamp(record.occurredAt)} | ${record.level.toUpperCase()} | ${escapeControls(record.event)} — ${escapeControls(record.message)}${fields.length ? ` | ${fields.join(" ")}` : ""}`;
}

export class HumanReadableLogger implements StructuredLogger {
  private readonly records: LogRecord[] = [];
  constructor(private readonly writeLine: (line: string) => void = line => process.stderr.write(line), private readonly capacity = 500) {}

  write(record: LogRecord): void {
    this.records.push(structuredClone(record));
    if (this.records.length > this.capacity) this.records.splice(0, this.records.length - this.capacity);
    this.writeLine(`${formatLogRecord(record)}\n`);
  }

  list(limit = 100): readonly LogRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.capacity) throw new TypeError(`log limit must be between 1 and ${this.capacity}`);
    return structuredClone(this.records.slice(-limit).reverse());
  }
}
