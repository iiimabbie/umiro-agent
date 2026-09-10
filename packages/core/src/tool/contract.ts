import type { AuthorizationTier, InteractionRequirement, ResourceRef } from "../authorization/authorize.js";
import type { Capability } from "../authorization/capability.js";
import type { ExecutionContext } from "../identity/execution-context.js";
import type { OperationError, SideEffectClass } from "../operation/index.js";
import type { JsonObject, JsonValue } from "../ports/json.js";

export interface ToolPolicy {
  readonly capability: Capability;
  readonly tier: AuthorizationTier;
  /** Separate from privilege: only operations that truly need a live human set this. */
  readonly interactionRequirement: InteractionRequirement;
  /** Exact-operation approval is independent from interactive-origin and privilege checks. */
  readonly approvalRequirement?: "not_required" | "required";
  readonly sideEffect: SideEffectClass;
  /** Exclusive by default. Only tools safe to overlap within one model turn opt in. */
  readonly concurrency?: "exclusive" | "parallel_safe";
  readonly timeoutMs?: number;
  readonly resource?: (input: JsonObject) => ResourceRef | undefined;
}

export interface ToolExecutionContext {
  readonly execution: ExecutionContext;
  readonly runId?: string;
  readonly operationId: string;
  readonly idempotencyKey?: string;
  readonly signal: AbortSignal;
}

export type ToolExecutionResult =
  | {
      readonly ok: true;
      readonly output: JsonValue;
      readonly effectStatus: "not_applicable" | "confirmed";
      /** Artifacts created by this operation; delivery references their durable IDs. */
      readonly artifactIds?: readonly string[];
    }
  | {
      readonly ok: false;
      readonly error: OperationError;
      readonly effectStatus: "not_applicable" | "confirmed" | "unknown";
      readonly output?: JsonValue;
      readonly artifactIds?: readonly string[];
    };

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  /** JSON Schema. The root must describe an object. */
  readonly inputSchema: Record<string, unknown>;
  readonly policy: ToolPolicy;
  readonly execute: (input: JsonObject, context: ToolExecutionContext) => Promise<ToolExecutionResult>;
}

export type ToolInvocationResult =
  | { readonly status: "tool_not_found"; readonly error: OperationError }
  | { readonly status: "invalid_input"; readonly error: OperationError }
  | { readonly status: "denied"; readonly operationId: string; readonly error: OperationError }
  | { readonly status: "approval_required"; readonly operationId: string; readonly approvalId: string; readonly expiresAt: string }
  | { readonly status: "succeeded"; readonly operationId: string; readonly output: JsonValue; readonly artifactIds?: readonly string[] }
  | {
      readonly status: "failed" | "cancelled" | "outcome_unknown";
      readonly operationId: string;
      readonly error: OperationError;
      readonly output?: JsonValue;
      readonly artifactIds?: readonly string[];
    };

export interface ToolInvocation {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly stepId: string;
  readonly context: ExecutionContext;
  readonly runId?: string;
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}
