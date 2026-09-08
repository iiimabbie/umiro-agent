import type { AuthorizationDecision } from "../authorization/authorize.js";
import type { JsonValue } from "../ports/json.js";

export type AuthorizationDecisionId = string;

export interface AuthorizationDecisionRecord extends AuthorizationDecision {
  readonly id: AuthorizationDecisionId;
  readonly operationId: string;
  readonly decidedAt: string;
}

export interface AuditEvent {
  readonly sequence: number;
  readonly kind: string;
  readonly entityType: "run" | "step" | "operation" | "authorization" | "model_call" | "output" | "delivery";
  readonly entityId: string;
  readonly runId: string;
  readonly data: JsonValue;
  readonly occurredAt: string;
}
