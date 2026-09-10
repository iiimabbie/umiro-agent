import type { JsonObject, JsonValue } from "../ports/json.js";

export interface OutputContract {
  readonly kind: "text" | "json" | "artifact";
  readonly schema?: JsonObject;
}

export interface BudgetCeiling {
  readonly maxModelTurns?: number;
  readonly maxToolCalls?: number;
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
  readonly maxDurationMs?: number;
}

export interface TaskPackage {
  readonly objective: string;
  readonly constraints: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly outputContract: OutputContract;
  readonly metadata?: JsonObject;
}

export interface DelegationRecord {
  readonly id: string;
  readonly parentRunId: string;
  readonly childRunId: string;
  /** Stable within one Parent Run; retries must reuse the same Child Run. */
  readonly idempotencyKey: string;
  readonly task: TaskPackage;
  readonly budgetCeiling?: BudgetCeiling;
  readonly state?: "active" | "waiting" | "succeeded" | "failed" | "cancelled";
  readonly createdAt: string;
  readonly updatedAt?: string;
  readonly cancelledAt?: string;
}

export interface ChildRunOutcome {
  readonly childRunId: string;
  readonly state: "active" | "succeeded" | "failed" | "cancelled" | "waiting";
  readonly output?: JsonValue;
}
