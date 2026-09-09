import type { PrincipalId } from "../identity/principal.js";

export type ApprovalState = "pending" | "approved" | "denied" | "expired" | "consumed";

export interface ApprovalRequest {
  readonly id: string;
  readonly operationId: string;
  readonly fingerprint: string;
  readonly state: ApprovalState;
  readonly requiredRole: "owner";
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly resolvedByPrincipalId?: PrincipalId;
  readonly resolvedAt?: string;
  readonly consumedAt?: string;
}

export type ApprovalResolution = "approve" | "deny";
