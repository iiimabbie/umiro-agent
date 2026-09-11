import { randomUUID } from "node:crypto";
import type { ExecutionProgressUpdate, ExecutionStore, JsonObject, JsonValue, OperationResult } from "@umiro/core";

export type CoreExecutionEventName =
  | "run.started"
  | "run.waiting"
  | "run.completed"
  | "step.started"
  | "step.completed"
  | "tool.started"
  | "tool.completed"
  | "delivery.completed"
  | "delivery.failed";

export interface CoreExecutionEventSink {
  emit(event: CoreExecutionEventName, payload: JsonObject): Promise<void>;
}

export interface ObservableExecutionStoreOptions {
  readonly now?: () => string;
  readonly createEventId?: () => string;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedAssistantText(value: string): string | undefined {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length <= 300 ? normalized : `${normalized.slice(0, 299).trimEnd()}…`;
}

/**
 * Publishes read-only Plugin events only after the corresponding durable write
 * succeeds. Payloads contain identifiers, lifecycle metadata, delivery routing,
 * and at most 300 characters of assistant progress text. Prompts, tool arguments,
 * tool outputs, and error messages are never published.
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
  const destinationPayload = async (runId: string, explicit?: JsonObject): Promise<JsonObject> => {
    if (explicit) return { destination: structuredClone(explicit) };
    try {
      const checkpoint = await target.getCheckpoint(runId);
      const data = checkpoint && isJsonObject(checkpoint.data) ? checkpoint.data : undefined;
      const destination = isJsonObject(data?.deliveryDestination) ? data.deliveryDestination : undefined;
      return destination ? { destination: structuredClone(destination) } : {};
    } catch { return {}; }
  };
  const stepPayload = async (stepId: string): Promise<JsonObject> => {
    try {
      const step = await target.getStep(stepId);
      return step ? { runId: step.runId, stepId: step.id, stepKind: step.kind, stepSequence: step.sequence } : { stepId };
    } catch { return { stepId }; }
  };
  const assistantPayload = async (runId: string, stepId: string): Promise<JsonObject> => {
    try {
      const calls = await target.listModelCalls(runId);
      const call = [...calls].reverse().find(candidate => candidate.stepId === stepId);
      const assistantText = boundedAssistantText(call?.response.text ?? "");
      return assistantText ? { assistantText } : {};
    } catch { return {}; }
  };
  const operationPayload = async (operationId: string): Promise<JsonObject> => {
    try {
      const operation = await target.getOperation(operationId);
      if (!operation) return { operationId };
      const step = await target.getStep(operation.stepId).catch(() => undefined);
      return {
        operationId: operation.id,
        stepId: operation.stepId,
        ...(step ? { runId: step.runId, ...(await destinationPayload(step.runId)) } : {}),
        tool: operation.kind.startsWith("tool:") ? operation.kind.slice(5) : operation.kind,
      };
    } catch { return { operationId }; }
  };
  const deliveryPayload = async (deliveryId: string): Promise<JsonObject> => {
    try {
      const delivery = await target.getDeliveryIntent(deliveryId);
      if (!delivery) return { deliveryId };
      return {
        deliveryId: delivery.id,
        runId: delivery.runId,
        destination: structuredClone(delivery.destination),
        state: delivery.state,
        ...(delivery.attempts !== undefined ? { attempts: delivery.attempts } : {}),
        ...(delivery.nextAttemptAt ? { nextAttemptAt: delivery.nextAttemptAt } : {}),
      };
    } catch { return { deliveryId }; }
  };

  return new Proxy(target, {
    get(object, property, receiver) {
      if (property === "updateExecutionProgress") return async (update: ExecutionProgressUpdate): Promise<void> => {
        await object.updateExecutionProgress(update);
        const step = update.step ? await stepPayload(update.step.id) : undefined;
        const destination = await destinationPayload(update.runId, update.terminalDelivery?.destination);
        if (update.expectedRunState === "queued" && update.runState === "running") {
          await publish("run.started", { runId: update.runId, ...destination, state: "running" });
        }
        if (step && update.step!.expectedState === "pending" && update.step!.state === "running") {
          await publish("step.started", { runId: update.runId, ...destination, ...step, state: "running" });
        } else if (step && update.step!.state !== "pending" && update.step!.state !== "running") {
          const assistant = step.stepKind === "model_call" ? await assistantPayload(update.runId, update.step!.id) : {};
          await publish("step.completed", { runId: update.runId, ...destination, ...step, ...assistant, state: update.step!.state });
        }
        if (update.runState === "waiting") {
          await publish("run.waiting", { runId: update.runId, ...destination, state: "waiting", ...(update.waitingReason ? { reason: update.waitingReason } : {}) });
        } else if (["failed", "cancelled", "timed_out"].includes(update.runState)) {
          await publish("run.completed", { runId: update.runId, ...destination, state: update.runState });
        }
      };
      if (property === "completeRunWithOutput") return async (completion: Parameters<ExecutionStore["completeRunWithOutput"]>[0]): Promise<void> => {
        await object.completeRunWithOutput(completion);
        await publish("run.completed", { runId: completion.output.runId, ...(await destinationPayload(completion.output.runId, completion.delivery.destination)), state: "succeeded" });
      };
      if (property === "markOperationExecuting") return async (operationId: string, updatedAt: string): Promise<void> => {
        await object.markOperationExecuting(operationId, updatedAt);
        await publish("tool.started", { ...(await operationPayload(operationId)), state: "executing" });
      };
      if (property === "recordOperationOutcome") return async (operationId: string, result: OperationResult, updatedAt: string): Promise<void> => {
        await object.recordOperationOutcome(operationId, result, updatedAt);
        await publish("tool.completed", { ...(await operationPayload(operationId)), state: result.outcome, effectStatus: result.effectStatus });
      };
      if (property === "markDeliveryDelivered") return async (deliveryId: string, deliveredAt: string, evidence?: JsonObject): Promise<void> => {
        await object.markDeliveryDelivered(deliveryId, deliveredAt, evidence);
        await publish("delivery.completed", await deliveryPayload(deliveryId));
      };
      if (property === "markDeliveryFailed") return async (deliveryId: string, error: string, nextAttemptAt: string, occurredAt: string): Promise<void> => {
        await object.markDeliveryFailed(deliveryId, error, nextAttemptAt, occurredAt);
        await publish("delivery.failed", { ...(await deliveryPayload(deliveryId)), willRetry: true });
      };
      const value = Reflect.get(object, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(object) : value;
    },
  });
}
