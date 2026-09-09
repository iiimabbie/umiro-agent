import type { JsonObject, JsonValue } from "../ports/json.js";

export interface ContextReference {
  readonly sourceRef: string;
  readonly label?: string;
}

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
  readonly contextRefs: readonly ContextReference[];
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
  readonly agentProfileRef?: string;
  readonly createdAt: string;
}

export interface ChildRunOutcome {
  readonly childRunId: string;
  readonly state: "active" | "succeeded" | "failed" | "cancelled" | "waiting";
  readonly output?: JsonValue;
}
