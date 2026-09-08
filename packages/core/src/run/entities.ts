import type { ExecutionContext } from "../identity/execution-context.js";

export type ConversationId = string;
export type TurnId = string;
export type RunId = string;
export type StepId = string;

export type RunState = "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "timed_out";
export type ResumeEligibility = "not_applicable" | "eligible" | "manual_review" | "ineligible";

export interface RunInterruption {
  readonly kind: "process_exit" | "shutdown" | "dependency_failure";
  readonly occurredAt: string;
  readonly detail?: string;
}

export interface Run {
  readonly id: RunId;
  readonly revision: number;
  readonly state: RunState;
  readonly context: ExecutionContext;
  readonly conversationId?: ConversationId;
  readonly turnId?: TurnId;
  readonly parentRunId?: RunId;
  readonly waitingReason?: string;
  readonly interruption?: RunInterruption;
  readonly resumeEligibility: ResumeEligibility;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type StepKind = "model_call" | "operation";
export type StepState = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out";

export interface Step {
  readonly id: StepId;
  readonly runId: RunId;
  readonly revision: number;
  readonly sequence: number;
  readonly kind: StepKind;
  readonly state: StepState;
  readonly createdAt: string;
  readonly updatedAt: string;
}
