import type { JsonObject } from "../ports/json.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  readonly runId?: string;
  readonly stepId?: string;
  readonly operationId?: string;
  readonly pluginId?: string;
  readonly conversationId?: string;
  readonly turnId?: string;
  readonly correlationId?: string;
}

export interface LogRecord extends LogContext {
  readonly level: LogLevel;
  readonly event: string;
  readonly message: string;
  readonly occurredAt: string;
  readonly data?: JsonObject;
}

export interface StructuredLogger {
  write(record: LogRecord): void;
}

export const NOOP_LOGGER: StructuredLogger = { write: () => undefined };
