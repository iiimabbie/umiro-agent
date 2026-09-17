import { deriveAuthority, type AuthorityScopeRequest } from "../authorization/authority.js";
import { ExecutionStoreConflictError, type ExecutionStore } from "../ports/execution-store.js";
import type { JsonObject } from "../ports/json.js";
import { HeadlessRunEngine, type HeadlessRunResult } from "../run/engine.js";
import type { Run, Step } from "../run/entities.js";
import type { BudgetCeiling, DelegationRecord, TaskPackage } from "./entities.js";
import type { DelegationStore } from "./store.js";

export interface ExecuteChildRunRequest {
  readonly parentRunId: string;
  readonly idempotencyKey: string;
  readonly task: TaskPackage;
  readonly authorityScope: AuthorityScopeRequest;
  readonly model: string;
  /** Compiled by the Subagent Plugin; Core stores Task Package separately. */
  readonly prompt: string;
  readonly budgetCeiling?: BudgetCeiling;
  readonly signal?: AbortSignal;
}

export type ChildRunExecutionResult =
  | { readonly status: "existing"; readonly childRunId: string; readonly runState: Run["state"] }
  | { readonly status: "succeeded"; readonly childRunId: string; readonly text: string; readonly reused: boolean }
  | { readonly status: "waiting" | "failed" | "cancelled"; readonly childRunId: string; readonly detail: string };

export type ChildRunStartResult = ChildRunExecutionResult | { readonly status: "active"; readonly childRunId: string };

export interface ChildRunServiceOptions {
  readonly now?: () => string;
  readonly createId?: (kind: "delegation" | "run" | "step") => string;
  readonly maxDepth?: number;
  readonly maxActiveChildrenPerPrincipal?: number;
  readonly resolveModel?: (selection: string) => string;
}

const BUDGET_KEYS = ["maxModelTurns", "maxToolCalls", "maxInputTokens", "maxOutputTokens", "maxDurationMs"] as const;

function narrowedBudget(parent: BudgetCeiling | undefined, requested: BudgetCeiling | undefined): BudgetCeiling | undefined {
  if (!parent) return requested;
  const effective: Partial<Record<(typeof BUDGET_KEYS)[number], number>> = {};
  for (const key of BUDGET_KEYS) {
    const ceiling = parent[key];
    const value = requested?.[key];
    if (ceiling !== undefined && value !== undefined && value > ceiling) throw new Error(`delegation budget ${key} exceeds Parent ceiling ${ceiling}`);
    if (value !== undefined) effective[key] = value;
    else if (ceiling !== undefined) effective[key] = ceiling;
  }
  return effective as BudgetCeiling;
}

export class ChildRunService {
  private readonly now: () => string;
  private readonly createId: NonNullable<ChildRunServiceOptions["createId"]>;
  private readonly maxDepth: number;
  private maxActiveChildrenPerPrincipal: number;
  private readonly resolveModel: (selection: string) => string;
  private readonly activeChildren = new Map<string, AbortController>();
  private readonly activeExecutions = new Map<string, Promise<ChildRunExecutionResult>>();

  constructor(
    private readonly engine: HeadlessRunEngine,
    private readonly store: ExecutionStore & DelegationStore,
    options: ChildRunServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? (() => crypto.randomUUID());
    this.maxDepth = options.maxDepth ?? 1;
    if (this.maxDepth !== 1) throw new TypeError("Subagent delegation depth is fixed at one level");
    this.maxActiveChildrenPerPrincipal = options.maxActiveChildrenPerPrincipal ?? 2;
    this.resolveModel = options.resolveModel ?? (selection => selection);
    if (!Number.isSafeInteger(this.maxActiveChildrenPerPrincipal) || this.maxActiveChildrenPerPrincipal <= 0) throw new TypeError("maxActiveChildrenPerPrincipal must be a positive safe integer");
  }

  setMaxActiveChildrenPerPrincipal(value: number): void {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError("maxActiveChildrenPerPrincipal must be a positive safe integer");
    this.maxActiveChildrenPerPrincipal = value;
  }

  async execute(request: ExecuteChildRunRequest): Promise<ChildRunExecutionResult> {
    this.validateRequest(request);
    const existing = await this.store.getDelegationByKey(request.parentRunId, request.idempotencyKey);
    if (existing) return this.existingResult(existing);

    const parent = await this.store.getRun(request.parentRunId);
    if (!parent || ["succeeded", "failed", "cancelled", "timed_out"].includes(parent.state)) {
      throw new Error(`Parent Run is unavailable for delegation: ${request.parentRunId}`);
    }
    if (parent.parentRunId) throw new Error("Child Runs cannot delegate another Subagent");
    let depth = 1; let ancestor = parent;
    while (ancestor.parentRunId) { depth += 1; if (depth > this.maxDepth) throw new Error(`delegation depth exceeds ${this.maxDepth}`); const next = await this.store.getRun(ancestor.parentRunId); if (!next) throw new Error(`delegation ancestor is missing: ${ancestor.parentRunId}`); ancestor = next; }
    const parentDelegation = parent.parentRunId ? await this.store.getDelegationByChildRunId(parent.id) : undefined;
    if (parent.parentRunId && !parentDelegation) throw new Error(`Parent Run delegation record is missing: ${parent.id}`);
    const budgetCeiling = narrowedBudget(parentDelegation?.budgetCeiling, request.budgetCeiling);

    const createdAt = this.now();
    const childRunId = this.createId("run");
    const childStepId = this.createId("step");
    const derived = deriveAuthority(parent.context.authority, request.authorityScope);
    const authority = { ...derived, capabilities: derived.capabilities.filter(capability => capability !== "subagent.delegate") };
    const run: Run = {
      id: childRunId,
      revision: 0,
      state: "queued",
      context: {
        origin: { kind: "delegation", parentRunId: parent.id },
        actor: parent.context.actor,
        authority,
      },
      parentRunId: parent.id,
      resumeEligibility: "eligible",
      createdAt,
      updatedAt: createdAt,
    };
    const firstStep: Step = {
      id: childStepId,
      runId: childRunId,
      revision: 0,
      sequence: 0,
      kind: "model_call",
      state: "pending",
      createdAt,
      updatedAt: createdAt,
    };
    const delegation: DelegationRecord = {
      id: this.createId("delegation"),
      parentRunId: parent.id,
      childRunId,
      idempotencyKey: request.idempotencyKey,
      task: structuredClone(request.task),
      ...(budgetCeiling ? { budgetCeiling: structuredClone(budgetCeiling) } : {}),
      createdAt,
    };
    await this.store.createChildRunWithStep(delegation, run, firstStep, { principalId: parent.context.actor.id, maxActiveChildren: this.maxActiveChildrenPerPrincipal });
    const controller = new AbortController();
    this.activeChildren.set(childRunId, controller);
    const signal = request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal;
    try {
      const result = await this.engine.runPrepared(childRunId, {
        model: this.resolveModel(request.model),
        prompt: request.prompt,
        deliveryDestination: { kind: "parent_run", parentRunId: parent.id } satisfies JsonObject,
        signal,
        ...(delegation.budgetCeiling?.maxModelTurns !== undefined ? { maxModelTurns: delegation.budgetCeiling.maxModelTurns } : {}),
        ...(delegation.budgetCeiling?.maxToolCalls !== undefined ? { maxToolCalls: delegation.budgetCeiling.maxToolCalls } : {}),
        ...(delegation.budgetCeiling?.maxInputTokens !== undefined ? { maxInputTokens: delegation.budgetCeiling.maxInputTokens } : {}),
        ...(delegation.budgetCeiling?.maxOutputTokens !== undefined ? { maxOutputTokens: delegation.budgetCeiling.maxOutputTokens } : {}),
        ...(delegation.budgetCeiling?.maxDurationMs !== undefined ? { maxDurationMs: delegation.budgetCeiling.maxDurationMs } : {}),
      });
      return this.projectResult(childRunId, result, false);
    } catch (error) {
      if (error instanceof ExecutionStoreConflictError && (await this.store.getRun(childRunId))?.state === "cancelled") return { status: "cancelled", childRunId, detail: "cancelled by Parent Run" };
      throw error;
    } finally {
      if (this.activeChildren.get(childRunId) === controller) this.activeChildren.delete(childRunId);
    }
  }

  /** Launch a durable Child Run and return its handle without waiting for completion. */
  async start(request: ExecuteChildRunRequest): Promise<ChildRunStartResult> {
    const existing = await this.store.getDelegationByKey(request.parentRunId, request.idempotencyKey);
    if (existing) {
      const terminal = await this.terminalResult(existing);
      return terminal ?? { status: "active", childRunId: existing.childRunId };
    }
    let settled = false;
    let outcome: ChildRunExecutionResult | undefined;
    let failure: unknown;
    const execution = this.execute(request);
    void execution.then(result => { settled = true; outcome = result; }, error => { settled = true; failure = error; });
    while (true) {
      const created = await this.store.getDelegationByKey(request.parentRunId, request.idempotencyKey);
      if (created) {
        if (!settled) {
          this.activeExecutions.set(created.childRunId, execution);
          void execution.then(
            () => { if (this.activeExecutions.get(created.childRunId) === execution) this.activeExecutions.delete(created.childRunId); },
            () => { if (this.activeExecutions.get(created.childRunId) === execution) this.activeExecutions.delete(created.childRunId); },
          );
          return { status: "active", childRunId: created.childRunId };
        }
        if (failure) throw failure;
        return outcome!;
      }
      if (settled) {
        if (failure) throw failure;
        return outcome!;
      }
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }

  /** Wait until any selected Child reaches a reportable state. */
  async waitForAny(parentRunId: string, childRunIds: readonly string[], signal?: AbortSignal): Promise<ChildRunExecutionResult> {
    if (!parentRunId.trim()) throw new TypeError("waiting requires a Parent Run ID");
    const delegations = childRunIds.length
      ? await Promise.all(childRunIds.map(async childRunId => {
          const delegation = await this.store.getDelegationByChildRunId(childRunId);
          if (!delegation || delegation.parentRunId !== parentRunId) throw new ExecutionStoreConflictError(`Child Run ${childRunId} does not belong to Parent Run ${parentRunId}`);
          return delegation;
        }))
      : [...await this.store.listChildDelegations(parentRunId)].filter(item => item.state === "active" || item.state === "waiting");
    if (!delegations.length) throw new Error("Parent Run has no selected Child Runs to wait for");
    const controller = new AbortController();
    const waitSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const awaitOne = async (delegation: DelegationRecord): Promise<ChildRunExecutionResult> => {
      const terminal = await this.terminalResult(delegation);
      if (terminal) return terminal;
      const active = this.activeExecutions.get(delegation.childRunId);
      if (active) return active;
      while (true) {
        if (waitSignal.aborted) throw waitSignal.reason ?? new Error("Subagent wait cancelled");
        const latest = await this.store.getDelegation(delegation.id);
        if (!latest) throw new Error(`delegation disappeared while waiting: ${delegation.id}`);
        const result = await this.terminalResult(latest);
        if (result) return result;
        await new Promise<void>((resolve, reject) => {
          const finish = () => { waitSignal.removeEventListener("abort", abort); resolve(); };
          const timer = setTimeout(finish, 50);
          const abort = () => { clearTimeout(timer); waitSignal.removeEventListener("abort", abort); reject(waitSignal.reason ?? new Error("Subagent wait cancelled")); };
          if (waitSignal.aborted) abort(); else waitSignal.addEventListener("abort", abort, { once: true });
        });
      }
    };
    try {
      const result = await Promise.race(delegations.map(awaitOne));
      this.activeExecutions.delete(result.childRunId);
      return result;
    } finally { controller.abort(new Error("another Child Run reported first")); }
  }

  async cancel(parentRunId: string, childRunId: string): Promise<{ readonly cancelled: boolean; readonly childRunId: string }> {
    if (!parentRunId.trim() || !childRunId.trim()) throw new TypeError("cancellation requires Parent and Child Run IDs");
    const cancelled = await this.store.cancelChildRun(parentRunId, childRunId, this.now());
    if (cancelled) this.activeChildren.get(childRunId)?.abort(new Error("cancelled by Parent Run"));
    return { cancelled, childRunId };
  }

  private async existingResult(delegation: DelegationRecord): Promise<ChildRunExecutionResult> {
    return (await this.terminalResult(delegation)) ?? (() => ({ status: "existing", childRunId: delegation.childRunId, runState: delegation.state === "waiting" ? "waiting" : "running" } as const))();
  }

  private async terminalResult(delegation: DelegationRecord): Promise<ChildRunExecutionResult | undefined> {
    const run = await this.store.getRun(delegation.childRunId);
    if (!run) throw new Error(`delegation ${delegation.id} references a missing Child Run`);
    if (run.state === "succeeded") {
      const output = await this.store.getRunOutput(run.id);
      if (!output) throw new Error(`succeeded Child Run ${run.id} has no durable output`);
      return { status: "succeeded", childRunId: run.id, text: output.text, reused: true };
    }
    if (run.state === "failed" || run.state === "cancelled" || run.state === "waiting") return { status: run.state, childRunId: run.id, detail: run.waitingReason ?? run.interruption?.detail ?? run.state };
    if (run.state === "timed_out") return { status: "failed", childRunId: run.id, detail: run.interruption?.detail ?? "timed out" };
    return undefined;
  }

  private projectResult(childRunId: string, result: HeadlessRunResult, reused: boolean): ChildRunExecutionResult {
    if (result.status === "succeeded") {
      return { status: "succeeded", childRunId, text: result.text, reused };
    }
    if (result.status === "waiting") {
      return { status: "waiting", childRunId, detail: result.reason };
    }
    return { status: result.status, childRunId, detail: result.error };
  }

  private validateRequest(request: ExecuteChildRunRequest): void {
    if (!request.parentRunId.trim()) throw new TypeError("delegation requires a Parent Run ID");
    if (!request.idempotencyKey.trim()) throw new TypeError("delegation requires an idempotency key");
    if (!request.task.objective.trim()) throw new TypeError("delegation requires an objective");
    if (!request.prompt.trim()) throw new TypeError("delegation requires a compiled prompt");
    if (!request.model.trim()) throw new TypeError("delegation requires a model");
    for (const [name, value] of Object.entries(request.budgetCeiling ?? {})) if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`delegation budget ${name} must be a positive safe integer`);
  }
}
