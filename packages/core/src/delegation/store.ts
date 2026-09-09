import type { Run, Step } from "../run/entities.js";
import type { DelegationRecord } from "./entities.js";

export interface DelegationStore {
  createChildRunWithStep(delegation: DelegationRecord, run: Run, firstStep: Step): Promise<void>;
  getDelegation(delegationId: string): Promise<DelegationRecord | undefined>;
  getDelegationByKey(parentRunId: string, idempotencyKey: string): Promise<DelegationRecord | undefined>;
  listChildDelegations(parentRunId: string): Promise<readonly DelegationRecord[]>;
}
