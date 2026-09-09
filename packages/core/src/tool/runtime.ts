import { randomUUID } from "node:crypto";
import type { ApprovalRequest } from "../approval/entities.js";
import { exactOperationFingerprint } from "../approval/fingerprint.js";
import type { AuthorizationDecisionRecord } from "../audit/records.js";
import { authorize } from "../authorization/authorize.js";
import type { Operation, OperationError, OperationResult } from "../operation/index.js";
import type { ExecutionStore } from "../ports/execution-store.js";
import type { JsonObject, JsonValue } from "../ports/json.js";
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolInvocation,
  ToolInvocationResult,
} from "./contract.js";
import { ToolRegistry } from "./registry.js";

export interface ToolRuntimeOptions {
  readonly now?: () => string;
  readonly createId?: (kind: "operation" | "authorization" | "approval") => string;
  readonly defaultTimeoutMs?: number;
  readonly approvalTtlMs?: number;
}

class ToolTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`tool timed out after ${timeoutMs}ms`);
    this.name = "ToolTimeoutError";
  }
}

class ToolContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolContractError";
  }
}

function operationError(code: string, message: string, retryable: boolean): OperationError {
  return { code, message: message.slice(0, 2_000), retryable };
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function projectResult(result: OperationResult): ToolInvocationResult {
  if (result.outcome === "succeeded") {
    return { status: "succeeded", operationId: result.operationId, output: result.output ?? null };
  }
  const error = result.error
    ?? operationError("operation_outcome_unknown", "the external effect could not be confirmed", true);
  return {
    status: result.outcome,
    operationId: result.operationId,
    error,
    ...(result.output !== undefined ? { output: result.output } : {}),
  };
}

function validateReturnedResult(tool: ToolDefinition, result: ToolExecutionResult): void {
  if (!result || typeof result !== "object" || typeof result.ok !== "boolean") {
    throw new ToolContractError(`tool ${tool.name} returned an invalid structured result`);
  }
  if (tool.policy.sideEffect === "none" && result.effectStatus !== "not_applicable") {
    throw new ToolContractError(`tool ${tool.name} has no side effect but returned ${result.effectStatus}`);
  }
  if (result.ok && tool.policy.sideEffect !== "none" && result.effectStatus !== "confirmed") {
    throw new ToolContractError(`mutating tool ${tool.name} must confirm its external effect on success`);
  }
  if (!result.ok && (!result.error || typeof result.error.code !== "string" || typeof result.error.message !== "string")) {
    throw new ToolContractError(`tool ${tool.name} returned an invalid structured error`);
  }
}

async function executeWithSignal(
  tool: ToolDefinition,
  input: JsonObject,
  context: Omit<ToolExecutionContext, "signal">,
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
): Promise<ToolExecutionResult> {
  const timeoutController = new AbortController();
  const timeoutError = new ToolTimeoutError(timeoutMs);
  const timer = setTimeout(() => timeoutController.abort(timeoutError), timeoutMs);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutController.signal]) : timeoutController.signal;
  let onAbort: (() => void) | undefined;
  const abort = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([tool.execute(input, { ...context, signal }), abort]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export class ToolRuntime {
  private readonly now: () => string;
  private readonly createId: NonNullable<ToolRuntimeOptions["createId"]>;
  private readonly defaultTimeoutMs: number;
  private readonly approvalTtlMs: number;

  constructor(
    private readonly registry: ToolRegistry,
    private readonly store: ExecutionStore,
    options: ToolRuntimeOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? (() => randomUUID());
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this.approvalTtlMs = options.approvalTtlMs ?? 5 * 60_000;
    if (!Number.isSafeInteger(this.defaultTimeoutMs) || this.defaultTimeoutMs <= 0) {
      throw new TypeError("default tool timeout must be a positive integer");
    }
    if (!Number.isSafeInteger(this.approvalTtlMs) || this.approvalTtlMs <= 0) throw new TypeError("approval TTL must be a positive integer");
  }

  async execute(invocation: ToolInvocation): Promise<ToolInvocationResult> {
    const tool = this.registry.get(invocation.toolName);
    if (!tool) {
      return {
        status: "tool_not_found",
        error: operationError("tool_not_found", `unknown tool: ${invocation.toolName}`, false),
      };
    }
    const validation = this.registry.validateInput(tool.name, invocation.input);
    if (!validation.valid) {
      return {
        status: "invalid_input",
        error: operationError("invalid_tool_input", validation.errors.join("; "), false),
      };
    }
    if (tool.policy.sideEffect === "non_idempotent" && invocation.idempotencyKey !== undefined) {
      return {
        status: "invalid_input",
        error: operationError("invalid_idempotency_key", "non-idempotent tools cannot accept an idempotency key", false),
      };
    }

    const operationId = this.createId("operation");
    const authorizationId = this.createId("authorization");
    const proposedAt = this.now();
    const input = invocation.input as JsonObject;
    const resource = tool.policy.resource?.(input);
    const decision = authorize({
      context: invocation.context,
      capability: tool.policy.capability,
      tier: tool.policy.tier,
      interactionRequirement: tool.policy.interactionRequirement,
      ...(resource ? { resource } : {}),
    });
    const operationKind = `tool:${tool.name}`;
    const suppliedIdempotencyKey = tool.policy.sideEffect === "idempotent"
      ? invocation.idempotencyKey?.trim() || undefined
      : undefined;
    if (decision.allow && suppliedIdempotencyKey) {
      const existing = await this.store.getOperationByIdempotencyKey(operationKind, suppliedIdempotencyKey);
      if (existing) {
        if (canonicalJson(existing.input) !== canonicalJson(input)) {
          return {
            status: "invalid_input",
            error: operationError(
              "idempotency_key_reused",
              "the idempotency key is already associated with different input",
              false,
            ),
          };
        }
        const persisted = await this.store.getOperationResult(existing.id);
        if (existing.state === "authorized") {
          return this.resumeAuthorizedTool(tool, existing, invocation, input, suppliedIdempotencyKey);
        }
        if (existing.state === "outcome_unknown" && !invocation.signal?.aborted) {
          return this.executeAuthorizedTool(tool, existing, invocation, input, suppliedIdempotencyKey);
        }
        if (persisted) return projectResult(persisted);
        if (existing.state === "executing") {
          return {
            status: "outcome_unknown",
            operationId: existing.id,
            error: operationError("operation_in_progress", "an operation with this idempotency key is already executing", true),
          };
        }
        throw new Error(`operation ${existing.id} has terminal state ${existing.state} without a result`);
      }
    }
    const decisionRecord: AuthorizationDecisionRecord = {
      ...decision,
      id: authorizationId,
      operationId,
      decidedAt: this.now(),
    };
    const idempotencyKey = tool.policy.sideEffect === "idempotent"
      ? (decision.allow ? suppliedIdempotencyKey : undefined) ?? operationId
      : undefined;
    const operation: Operation = {
      id: operationId,
      stepId: invocation.stepId,
      kind: operationKind,
      input,
      state: decision.allow ? "authorized" : "denied",
      capability: tool.policy.capability,
      authorizationTier: tool.policy.tier,
      sideEffect: tool.policy.sideEffect,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      authorizationDecisionId: authorizationId,
      createdAt: proposedAt,
      updatedAt: decisionRecord.decidedAt,
    };
    const approval: ApprovalRequest | undefined = decision.allow && tool.policy.approvalRequirement === "required" ? {
      id: this.createId("approval"),
      operationId,
      fingerprint: exactOperationFingerprint(operation, decisionRecord),
      state: "pending",
      requiredRole: "owner",
      requestedAt: decisionRecord.decidedAt,
      expiresAt: new Date(Date.parse(decisionRecord.decidedAt) + this.approvalTtlMs).toISOString(),
    } : undefined;
    await this.store.recordOperationAuthorization(operation, decisionRecord, approval);
    if (!decision.allow) {
      return {
        status: "denied",
        operationId,
        error: operationError("permission_denied", decision.reason, false),
      };
    }
    if (approval) return { status: "approval_required", operationId, approvalId: approval.id, expiresAt: approval.expiresAt };

    return this.executeAuthorizedTool(tool, operation, invocation, input, idempotencyKey);
  }

  async resume(operationId: string, invocation: ToolInvocation): Promise<ToolInvocationResult> {
    const tool = this.registry.get(invocation.toolName);
    if (!tool) return { status: "tool_not_found", error: operationError("tool_not_found", `unknown tool: ${invocation.toolName}`, false) };
    const operation = await this.store.getOperation(operationId);
    if (!operation || operation.stepId !== invocation.stepId || operation.kind !== `tool:${tool.name}` || canonicalJson(operation.input) !== canonicalJson(invocation.input as JsonObject)) {
      return { status: "invalid_input", error: operationError("operation_mismatch", "stored operation does not match the pending tool call", false) };
    }
    const persisted = await this.store.getOperationResult(operation.id);
    if (persisted) return projectResult(persisted);
    if (operation.state !== "authorized") return { status: "outcome_unknown", operationId, error: operationError("operation_not_resumable", `operation is ${operation.state}`, false) };
    return this.resumeAuthorizedTool(tool, operation, invocation, operation.input, operation.idempotencyKey);
  }

  private async resumeAuthorizedTool(tool: ToolDefinition, operation: Operation, invocation: ToolInvocation, input: JsonObject, idempotencyKey: string | undefined): Promise<ToolInvocationResult> {
    const approval = await this.store.getApprovalByOperation(operation.id);
    if (!approval) {
      if (tool.policy.approvalRequirement === "required") {
        const error = operationError("approval_missing", "exact-operation approval is missing", false);
        await this.persistOutcome(operation, { operationId: operation.id, outcome: "failed", effectStatus: "not_applicable", error, completedAt: this.now() });
        return { status: "failed", operationId: operation.id, error };
      }
      return this.executeAuthorizedTool(tool, operation, invocation, input, idempotencyKey);
    }
    if (approval.state === "pending") return { status: "approval_required", operationId: operation.id, approvalId: approval.id, expiresAt: approval.expiresAt };
    if (approval.state === "denied" || approval.state === "expired") {
      const error = operationError(approval.state === "denied" ? "approval_denied" : "approval_expired", `operation approval was ${approval.state}`, false);
      await this.persistOutcome(operation, { operationId: operation.id, outcome: "failed", effectStatus: "not_applicable", error, completedAt: this.now() });
      return { status: "failed", operationId: operation.id, error };
    }
    if (approval.state !== "approved") return { status: "outcome_unknown", operationId: operation.id, error: operationError("approval_already_consumed", "operation approval was already consumed", false) };
    if (invocation.signal?.aborted) {
      const error = operationError("tool_cancelled", "tool invocation was cancelled before approval consumption", false);
      await this.persistOutcome(operation, { operationId: operation.id, outcome: "cancelled", effectStatus: "not_applicable", error, completedAt: this.now() });
      return { status: "cancelled", operationId: operation.id, error };
    }
    const resource = tool.policy.resource?.(input);
    const revalidated = authorize({ context: invocation.context, capability: tool.policy.capability, tier: tool.policy.tier, interactionRequirement: tool.policy.interactionRequirement, ...(resource ? { resource } : {}) });
    if (!revalidated.allow) {
      const error = operationError("approval_revalidation_failed", revalidated.reason, false);
      await this.persistOutcome(operation, { operationId: operation.id, outcome: "failed", effectStatus: "not_applicable", error, completedAt: this.now() });
      return { status: "failed", operationId: operation.id, error };
    }
    const revalidationRecord: AuthorizationDecisionRecord = { ...revalidated, id: operation.authorizationDecisionId!, operationId: operation.id, decidedAt: this.now() };
    const fingerprint = exactOperationFingerprint(operation, revalidationRecord);
    await this.store.consumeApprovalAndMarkExecuting(operation.id, fingerprint, this.now());
    return this.executeMarkedTool(tool, operation, invocation, input, idempotencyKey);
  }

  private async executeAuthorizedTool(
    tool: ToolDefinition,
    operation: Operation,
    invocation: ToolInvocation,
    input: JsonObject,
    idempotencyKey: string | undefined,
  ): Promise<ToolInvocationResult> {
    const operationId = operation.id;
    if (invocation.signal?.aborted) {
      const cancelled = operationError("tool_cancelled", "tool invocation was cancelled before execution", false);
      await this.persistOutcome(operation, {
        operationId,
        outcome: "cancelled",
        effectStatus: "not_applicable",
        error: cancelled,
        completedAt: this.now(),
      });
      return { status: "cancelled", operationId, error: cancelled };
    }

    await this.store.markOperationExecuting(operationId, this.now());
    return this.executeMarkedTool(tool, operation, invocation, input, idempotencyKey);
  }

  private async executeMarkedTool(
    tool: ToolDefinition,
    operation: Operation,
    invocation: ToolInvocation,
    input: JsonObject,
    idempotencyKey: string | undefined,
  ): Promise<ToolInvocationResult> {
    const operationId = operation.id;
    const timeoutMs = tool.policy.timeoutMs ?? this.defaultTimeoutMs;
    let executionResult: ToolExecutionResult;
    try {
      executionResult = await executeWithSignal(
        tool,
        input,
        {
          execution: invocation.context,
          ...(invocation.runId ? { runId: invocation.runId } : {}),
          operationId,
          ...(idempotencyKey ? { idempotencyKey } : {}),
        },
        timeoutMs,
        invocation.signal,
      );
      validateReturnedResult(tool, executionResult);
    } catch (caught) {
      return this.persistExecutionFailure(operation, invocation, caught);
    }

    if (executionResult.ok) {
      await this.persistOutcome(operation, {
        operationId,
        outcome: "succeeded",
        effectStatus: executionResult.effectStatus,
        output: executionResult.output,
        completedAt: this.now(),
      });
      return { status: "succeeded", operationId, output: executionResult.output };
    }

    const outcome = executionResult.effectStatus === "unknown" ? "outcome_unknown" : "failed";
    await this.persistOutcome(operation, {
      operationId,
      outcome,
      effectStatus: executionResult.effectStatus,
      ...(executionResult.output !== undefined ? { output: executionResult.output } : {}),
      error: executionResult.error,
      completedAt: this.now(),
    });
    return {
      status: outcome,
      operationId,
      error: executionResult.error,
      ...(executionResult.output !== undefined ? { output: executionResult.output } : {}),
    };
  }

  private async persistExecutionFailure(
    operation: Operation,
    invocation: ToolInvocation,
    caught: unknown,
  ): Promise<ToolInvocationResult> {
    const caughtError = asError(caught);
    const timedOut = caughtError instanceof ToolTimeoutError;
    const cancelled = !timedOut && invocation.signal?.aborted === true;
    const contractViolation = caughtError instanceof ToolContractError;
    const error = timedOut
      ? operationError("tool_timeout", caughtError.message, operation.sideEffect !== "non_idempotent")
      : cancelled
        ? operationError("tool_cancelled", "tool invocation was cancelled", false)
        : contractViolation
          ? operationError("tool_contract_violation", caughtError.message, false)
          : operationError("tool_execution_failed", caughtError.message, false);
    // Once execution has started, an invalid return value says nothing about
    // whether a mutating tool already changed the external world.
    const effectCouldBeUnknown = operation.sideEffect !== "none";
    const outcome = effectCouldBeUnknown ? "outcome_unknown" : cancelled ? "cancelled" : "failed";
    await this.persistOutcome(operation, {
      operationId: operation.id,
      outcome,
      effectStatus: effectCouldBeUnknown ? "unknown" : "not_applicable",
      error,
      completedAt: this.now(),
    });
    return { status: outcome, operationId: operation.id, error };
  }

  private async persistOutcome(operation: Operation, result: OperationResult): Promise<void> {
    await this.store.recordOperationOutcome(operation.id, result, result.completedAt);
  }
}
