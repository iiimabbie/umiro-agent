import type { JsonValue } from "../ports/json.js";
import type { OperationId } from "./entities.js";

export type OperationOutcomeState = "succeeded" | "failed" | "outcome_unknown" | "cancelled";
export type ExternalEffectStatus = "not_applicable" | "confirmed" | "unknown";

export interface OperationError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface OperationResult {
  readonly operationId: OperationId;
  readonly outcome: OperationOutcomeState;
  readonly effectStatus: ExternalEffectStatus;
  readonly output?: JsonValue;
  readonly artifactIds?: readonly string[];
  /** Artifacts visible only to the next model turn, never final delivery. */
  readonly modelInputArtifactIds?: readonly string[];
  readonly error?: OperationError;
  readonly completedAt: string;
}

export function assertOperationResult(result: OperationResult): void {
  for (const field of [result.artifactIds, result.modelInputArtifactIds]) {
    if (field !== undefined && (!Array.isArray(field) || field.some(id => typeof id !== "string" || id.length === 0))) {
      throw new TypeError("operation artifact IDs must be non-empty strings");
    }
  }
  if (result.outcome === "outcome_unknown" && result.effectStatus !== "unknown") {
    throw new TypeError("outcome_unknown requires an unknown external effect status");
  }
  if (result.outcome === "succeeded" && result.error) {
    throw new TypeError("a succeeded operation cannot contain an error");
  }
  if (result.outcome === "failed" && !result.error) {
    throw new TypeError("a failed operation requires an error");
  }
  if (result.outcome === "cancelled" && (!result.error || result.effectStatus === "unknown")) {
    throw new TypeError("a cancelled operation requires an error and a known external effect status");
  }
}
