import type { PrincipalId } from "../identity/principal.js";
import type { ApprovalRequest, ApprovalResolution } from "./entities.js";

export interface ApprovalStore {
  getApproval(id: string): Promise<ApprovalRequest | undefined>;
  getApprovalByOperation(operationId: string): Promise<ApprovalRequest | undefined>;
  listPendingApprovals(limit: number): Promise<readonly ApprovalRequest[]>;
  resolveApproval(id: string, resolution: ApprovalResolution, resolvedByPrincipalId: PrincipalId, resolvedAt: string): Promise<ApprovalRequest>;
  consumeApprovalAndMarkExecuting(operationId: string, fingerprint: string, consumedAt: string): Promise<void>;
}
