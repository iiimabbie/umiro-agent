import { randomUUID } from "node:crypto";
import type { ExecutionProgressUpdate, ExecutionStore, JsonObject, OperationResult } from "@umiro/core";

export type CoreExecutionEventName =
  | "run.started"
  | "run.waiting"
  | "run.completed"
  | "step.started"
  | "step.completed"
  | "tool.started"
  | "tool.completed";

export interface CoreExecutionEventSink {
  emit(event: CoreExecutionEventName, payload: JsonObject): Promise<void>;
}

export interface ObservableExecutionStoreOptions {
  readonly now?: () => string;
  readonly createEventId?: () => string;
}

/**
 * Publishes read-only Plugin events only after the corresponding durable write
 * succeeds. Payloads deliberately contain identifiers and lifecycle metadata,
 * never prompts, tool arguments, outputs, or error messages.
 */
export function observeExecutionStore<T extends ExecutionStore>(
  target: T,
  sink: CoreExecutionEventSink,
  options: ObservableExecutionStoreOptions = {},
): T {
  const now = options.now ?? (() => new Date().toISOString());
  const createEventId = options.createEventId ?? (() => randomUUID());
  const publish = async (event: CoreExecutionEventName, data: JsonObject): Promise<void> => {
    try {
      await sink.emit(event, {
        schemaVersion: 1,
        eventId: createEventId(),
        occurredAt: now(),
        producer: "core.execution-store",
        ...data,
      });
    } catch {
      // Observers are never allowed to alter a committed execution transition.
    }
  };
  const stepPayload = async (stepId: string): Promise<JsonObject> => {
    const step = await target.getStep(stepId);
    return step ? { stepId: step.id, stepKind: step.kind, stepSequence: step.sequence } : { stepId };
  };
  const operationPayload = async (operationId: string): Promise<JsonObject> => {
    const operation = await target.getOperation(operationId);
    return operation
      ? { operationId: operation.id, stepId: operation.stepId, tool: operation.kind.startsWith("tool:") ? operation.kind.slice(5) : operation.kind }
      : { operationId };
  };

  return new Proxy(target, {
    get(object, property, receiver) {
      if (property === "updateExecutionProgress") return async (update: ExecutionProgressUpdate): Promise<void> => {
        await object.updateExecutionProgress(update);
        const step = update.step ? await stepPayload(update.step.id) : undefined;
        if (update.expectedRunState === "queued" && update.runState === "running") {
          await publish("run.started", { runId: update.runId, state: "running" });
        }
        if (step && update.step!.expectedState === "pending" && update.step!.state === "running") {
          await publish("step.started", { runId: update.runId, ...step, state: "running" });
        } else if (step && update.step!.state !== "pending" && update.step!.state !== "running") {
          await publish("step.completed", { runId: update.runId, ...step, state: update.step!.state });
        }
        if (update.runState === "waiting") {
          await publish("run.waiting", { runId: update.runId, state: "waiting", ...(update.waitingReason ? { reason: update.waitingReason } : {}) });
        } else if (["failed", "cancelled", "timed_out"].includes(update.runState)) {
          await publish("run.completed", { runId: update.runId, state: update.runState });
        }
      };
      if (property === "completeRunWithOutput") return async (completion: Parameters<ExecutionStore["completeRunWithOutput"]>[0]): Promise<void> => {
        await object.completeRunWithOutput(completion);
        await publish("run.completed", { runId: completion.output.runId, state: "succeeded" });
      };
      if (property === "markOperationExecuting") return async (operationId: string, updatedAt: string): Promise<void> => {
        await object.markOperationExecuting(operationId, updatedAt);
        await publish("tool.started", { ...(await operationPayload(operationId)), state: "executing" });
      };
      if (property === "recordOperationOutcome") return async (operationId: string, result: OperationResult, updatedAt: string): Promise<void> => {
        await object.recordOperationOutcome(operationId, result, updatedAt);
        await publish("tool.completed", { ...(await operationPayload(operationId)), state: result.outcome, effectStatus: result.effectStatus });
      };
      const value = Reflect.get(object, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(object) : value;
    },
  });
}
