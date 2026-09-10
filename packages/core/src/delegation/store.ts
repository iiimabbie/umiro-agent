import type { Run, Step } from "../run/entities.js";
import type { DelegationRecord } from "./entities.js";

export interface DelegationStore {
  createChildRunWithStep(delegation: DelegationRecord, run: Run, firstStep: Step, concurrency?: { readonly principalId: string; readonly maxActiveChildren: number }): Promise<void>;
  getDelegation(delegationId: string): Promise<DelegationRecord | undefined>;
  getDelegationByChildRunId(childRunId: string): Promise<DelegationRecord | undefined>;
  getDelegationByKey(parentRunId: string, idempotencyKey: string): Promise<DelegationRecord | undefined>;
  listChildDelegations(parentRunId: string): Promise<readonly DelegationRecord[]>;
  /** Atomically cancels one Child Run only when it belongs to the supplied Parent Run. */
  cancelChildRun(parentRunId: string, childRunId: string, cancelledAt: string): Promise<boolean>;
}
