import { deriveAuthority, type AuthorityScopeRequest } from "../authorization/authority.js";
import type { ExecutionStore } from "../ports/execution-store.js";
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
  readonly agentProfileRef?: string;
  readonly signal?: AbortSignal;
}

export type ChildRunExecutionResult =
  | { readonly status: "existing"; readonly childRunId: string; readonly runState: Run["state"] }
  | { readonly status: "succeeded"; readonly childRunId: string; readonly text: string; readonly reused: boolean }
  | { readonly status: "waiting" | "failed" | "cancelled"; readonly childRunId: string; readonly detail: string };

export interface ChildRunServiceOptions {
  readonly now?: () => string;
  readonly createId?: (kind: "delegation" | "run" | "step") => string;
  readonly maxDepth?: number;
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

  constructor(
    private readonly engine: HeadlessRunEngine,
    private readonly store: ExecutionStore & DelegationStore,
    options: ChildRunServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? (() => crypto.randomUUID());
    this.maxDepth = options.maxDepth ?? 4;
    if (!Number.isSafeInteger(this.maxDepth) || this.maxDepth <= 0) throw new TypeError("maxDepth must be a positive safe integer");
  }

  async execute(request: ExecuteChildRunRequest): Promise<ChildRunExecutionResult> {
    this.validateRequest(request);
    const existing = await this.store.getDelegationByKey(request.parentRunId, request.idempotencyKey);
    if (existing) return this.existingResult(existing);

    const parent = await this.store.getRun(request.parentRunId);
    if (!parent || ["succeeded", "failed", "cancelled", "timed_out"].includes(parent.state)) {
      throw new Error(`Parent Run is unavailable for delegation: ${request.parentRunId}`);
    }
    let depth = 1; let ancestor = parent;
    while (ancestor.parentRunId) { depth += 1; if (depth > this.maxDepth) throw new Error(`delegation depth exceeds ${this.maxDepth}`); const next = await this.store.getRun(ancestor.parentRunId); if (!next) throw new Error(`delegation ancestor is missing: ${ancestor.parentRunId}`); ancestor = next; }
    const parentDelegation = parent.parentRunId ? await this.store.getDelegationByChildRunId(parent.id) : undefined;
    if (parent.parentRunId && !parentDelegation) throw new Error(`Parent Run delegation record is missing: ${parent.id}`);
    const budgetCeiling = narrowedBudget(parentDelegation?.budgetCeiling, request.budgetCeiling);

    const createdAt = this.now();
    const childRunId = this.createId("run");
    const childStepId = this.createId("step");
    const authority = deriveAuthority(parent.context.authority, request.authorityScope);
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
      ...(request.agentProfileRef ? { agentProfileRef: request.agentProfileRef } : {}),
      createdAt,
    };
    await this.store.createChildRunWithStep(delegation, run, firstStep);
    const result = await this.engine.runPrepared(childRunId, {
      model: request.model,
      prompt: request.prompt,
      deliveryDestination: { kind: "parent_run", parentRunId: parent.id } satisfies JsonObject,
      ...(request.signal ? { signal: request.signal } : {}),
      ...(delegation.budgetCeiling?.maxModelTurns !== undefined
        ? { maxModelTurns: delegation.budgetCeiling.maxModelTurns }
        : {}),
      ...(delegation.budgetCeiling?.maxToolCalls !== undefined ? { maxToolCalls: delegation.budgetCeiling.maxToolCalls } : {}),
      ...(delegation.budgetCeiling?.maxInputTokens !== undefined ? { maxInputTokens: delegation.budgetCeiling.maxInputTokens } : {}),
      ...(delegation.budgetCeiling?.maxOutputTokens !== undefined ? { maxOutputTokens: delegation.budgetCeiling.maxOutputTokens } : {}),
      ...(delegation.budgetCeiling?.maxDurationMs !== undefined ? { maxDurationMs: delegation.budgetCeiling.maxDurationMs } : {}),
    });
    return this.projectResult(childRunId, result, false);
  }

  private async existingResult(delegation: DelegationRecord): Promise<ChildRunExecutionResult> {
    const run = await this.store.getRun(delegation.childRunId);
    if (!run) throw new Error(`delegation ${delegation.id} references a missing Child Run`);
    if (run.state === "succeeded") {
      const output = await this.store.getRunOutput(run.id);
      if (!output) throw new Error(`succeeded Child Run ${run.id} has no durable output`);
      return { status: "succeeded", childRunId: run.id, text: output.text, reused: true };
    }
    return { status: "existing", childRunId: run.id, runState: run.state };
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
