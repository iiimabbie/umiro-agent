import type { JsonObject } from "../ports/json.js";

export type ErrorCategory =
  | "validation"
  | "authorization"
  | "conflict"
  | "dependency"
  | "timeout"
  | "cancelled"
  | "unknown_outcome"
  | "internal";

export interface ClassifiedError {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly safeMessage: string;
  readonly retryable: boolean;
  readonly data?: JsonObject;
}

export class UmiroError extends Error {
  constructor(readonly classification: ClassifiedError, options?: ErrorOptions) {
    super(classification.safeMessage, options);
    this.name = "UmiroError";
  }
}

export function classifyUnknownError(error: unknown): ClassifiedError {
  if (error instanceof UmiroError) return error.classification;
  return {
    code: "internal_error",
    category: "internal",
    safeMessage: "An internal error occurred",
    retryable: false,
  };
}
