import { isOwner } from "../identity/principal.js";
import type { ExecutionContext } from "../identity/execution-context.js";
import type { ApprovalRequest, ApprovalResolution } from "./entities.js";
import type { ApprovalStore } from "./store.js";

export class ApprovalService {
  constructor(private readonly store: ApprovalStore, private readonly now = () => new Date().toISOString()) {}

  async resolve(id: string, resolution: ApprovalResolution, context: ExecutionContext): Promise<ApprovalRequest> {
    if (!id.trim()) throw new TypeError("approval ID is required");
    if (context.origin.kind !== "interactive") throw new Error("approval requires an interactive origin");
    if (!isOwner(context.actor)) throw new Error("approval requires an owner Principal");
    return this.store.resolveApproval(id, resolution, context.actor.id, this.now());
  }
}
