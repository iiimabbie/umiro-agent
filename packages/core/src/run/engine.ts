import type { ModelMessage, ModelPort, ModelToolCall, ModelUsage } from "../model/contract.js";
import type { OperationResult } from "../operation/result.js";
import { ExecutionStoreConflictError, type ExecutionStore } from "../ports/execution-store.js";
import type { JsonObject, JsonValue } from "../ports/json.js";
import { ToolRegistry, ToolRuntime } from "../tool/index.js";
import type { ExecutionContext } from "../identity/execution-context.js";
import { renderContextAssembly, type ContextAssembly } from "../context/index.js";
import type { Run, Step } from "./entities.js";
import { RunNotRecoverableError, type RecoveryClaim } from "./recovery.js";

export interface HeadlessRunRequest {
  readonly context: ExecutionContext;
  readonly model: string;
  readonly prompt: string;
  readonly signal?: AbortSignal;
  readonly maxModelTurns?: number;
  readonly maxToolCalls?: number;
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
  readonly maxDurationMs?: number;
  readonly deliveryDestination?: JsonObject;
  readonly conversationId?: string;
  readonly turnId?: string;
  readonly assembledContext?: ContextAssembly;
  /** Used by durable ingress to reserve a stable Run ID before execution starts. */
  readonly runId?: string;
}

export type HeadlessPreparedRunRequest = Omit<HeadlessRunRequest, "context" | "conversationId" | "turnId" | "runId">;

export interface HeadlessResumeRequest {
  readonly signal?: AbortSignal;
  readonly maxModelTurns?: number;
}

export type HeadlessRunResult =
  | { readonly status: "succeeded"; readonly runId: string; readonly deliveryId: string; readonly text: string; readonly usage: ModelUsage }
  | { readonly status: "waiting"; readonly runId: string; readonly reason: "outcome_unknown" }
  | { readonly status: "failed" | "cancelled"; readonly runId: string; readonly error: string };

export interface HeadlessRunEngineOptions {
  readonly now?: () => string;
  readonly createId?: (kind: "run" | "step" | "model_call" | "output" | "delivery" | "operation" | "authorization") => string;
}

const ZERO_USAGE: ModelUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };

function initialMessages(request: Pick<HeadlessRunRequest, "prompt" | "assembledContext">): ModelMessage[] {
  return [
    ...(request.assembledContext?.blocks.length
      ? [{ role: "system" as const, content: renderContextAssembly(request.assembledContext) }]
      : []),
    { role: "user" as const, content: request.prompt },
  ];
}

function addUsage(left: ModelUsage, right: ModelUsage): ModelUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
  };
}

function validateRunLimits(request: HeadlessRunRequest): void {
  for (const [name, value] of Object.entries({
    maxModelTurns: request.maxModelTurns,
    maxToolCalls: request.maxToolCalls,
    maxInputTokens: request.maxInputTokens,
    maxOutputTokens: request.maxOutputTokens,
    maxDurationMs: request.maxDurationMs,
  })) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new TypeError(`${name} must be a positive safe integer`);
    }
  }
}

function checkpointData(model: string, messages: readonly ModelMessage[], usage: ModelUsage, deliveryDestination: JsonObject): JsonValue {
  return JSON.parse(JSON.stringify({ version: 1, model, messages, usage, deliveryDestination })) as JsonValue;
}

function restoredCheckpoint(claim: RecoveryClaim): { model: string; messages: ModelMessage[]; usage: ModelUsage; deliveryDestination: JsonObject } {
  const data = claim.checkpoint.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new RunNotRecoverableError(claim.run.id, "checkpoint payload is invalid");
  }
  const payload = data as Record<string, JsonValue>;
  const model = payload.model;
  const messages = payload.messages;
  const usage = payload.usage;
  const deliveryDestination = payload.deliveryDestination;
  const usageRecord = usage && typeof usage === "object" && !Array.isArray(usage)
    ? usage as Record<string, JsonValue>
    : undefined;
  if (payload.version !== 1 || typeof model !== "string" || !Array.isArray(messages)
    || !usageRecord || (deliveryDestination !== undefined
      && (!deliveryDestination || typeof deliveryDestination !== "object" || Array.isArray(deliveryDestination)))
    || typeof usageRecord.inputTokens !== "number" || typeof usageRecord.outputTokens !== "number"
    || typeof usageRecord.reasoningTokens !== "number") {
    throw new RunNotRecoverableError(claim.run.id, "checkpoint payload has an unsupported shape");
  }
  return {
    model,
    messages: structuredClone(messages) as ModelMessage[],
    usage: {
      inputTokens: usageRecord.inputTokens,
      outputTokens: usageRecord.outputTokens,
      reasoningTokens: usageRecord.reasoningTokens,
    },
    deliveryDestination: deliveryDestination
      ? structuredClone(deliveryDestination) as JsonObject
      : { kind: "caller" },
  };
}

interface RestoredExecution {
  readonly runId: string;
  readonly runRevision: number;
  readonly sequence: number;
  readonly checkpointVersion: number;
  readonly usage: ModelUsage;
  readonly messages: ModelMessage[];
  readonly modelStep: Step;
  readonly deliveryDestination: JsonObject;
}

export class HeadlessRunEngine {
  private readonly now: () => string;
  private readonly createId: NonNullable<HeadlessRunEngineOptions["createId"]>;
  private readonly toolRuntime: ToolRuntime;

  constructor(
    private readonly modelPort: ModelPort,
    private readonly tools: ToolRegistry,
    private readonly store: ExecutionStore,
    options: HeadlessRunEngineOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? ((_kind) => crypto.randomUUID());
    this.toolRuntime = new ToolRuntime(tools, store, { now: this.now, createId: kind => this.createId(kind) });
  }

  async run(request: HeadlessRunRequest): Promise<HeadlessRunResult> {
    return this.execute(request);
  }

  /** Starts a Run whose row and first Step were already created in another atomic transaction. */
  async runPrepared(runId: string, request: HeadlessPreparedRunRequest): Promise<HeadlessRunResult> {
    const run = await this.store.getRun(runId);
    const steps = await this.store.listSteps(runId);
    const modelStep = steps[0];
    if (!run || run.state !== "queued" || run.revision !== 0) {
      throw new ExecutionStoreConflictError(`prepared Run ${runId} is not queued at revision zero`);
    }
    if (!modelStep || steps.length !== 1 || modelStep.sequence !== 0 || modelStep.kind !== "model_call"
      || modelStep.state !== "pending" || modelStep.revision !== 0) {
      throw new ExecutionStoreConflictError(`prepared Run ${runId} does not have one pending model Step`);
    }
    const deliveryDestination = request.deliveryDestination ?? { kind: "caller" };
    const messages = initialMessages(request);
    await this.store.updateExecutionProgress({
      runId,
      expectedRunRevision: 0,
      expectedRunState: "queued",
      runState: "running",
      resumeEligibility: "eligible",
      runUpdatedAt: this.now(),
      step: { id: modelStep.id, expectedRevision: 0, expectedState: "pending", state: "running", updatedAt: this.now() },
      checkpoint: {
        runId,
        version: 1,
        data: checkpointData(request.model, messages, ZERO_USAGE, deliveryDestination),
        updatedAt: this.now(),
      },
    });
    return this.execute({
      context: run.context,
      ...request,
      deliveryDestination,
    }, {
      runId,
      runRevision: 1,
      sequence: 1,
      checkpointVersion: 1,
      usage: ZERO_USAGE,
      messages,
      modelStep: { ...modelStep, revision: 1, state: "running" },
      deliveryDestination,
    });
  }

  async resume(claim: RecoveryClaim, request: HeadlessResumeRequest = {}): Promise<HeadlessRunResult> {
    if (claim.run.state !== "running" || claim.run.resumeEligibility !== "eligible") {
      throw new RunNotRecoverableError(claim.run.id, "the Run has not been claimed");
    }
    const modelStep = claim.steps.at(-1);
    const checkpoint = restoredCheckpoint(claim);
    if (!modelStep) throw new RunNotRecoverableError(claim.run.id, "the Run has no current Step");
    if (modelStep.state === "pending") return this.resumePendingCursor(claim, checkpoint, request, modelStep);
    if (modelStep.kind === "operation" && modelStep.state === "running") {
      return this.resumeOperationCursor(claim, checkpoint, request, modelStep);
    }
    if (modelStep.kind === "operation" && modelStep.state === "succeeded") {
      return this.resumeAfterCompletedOperation(claim, checkpoint, request, modelStep);
    }
    if (modelStep.kind === "model_call" && modelStep.state === "succeeded") {
      return this.resumeAfterCompletedModelCall(claim, checkpoint, request, modelStep);
    }
    if (modelStep.kind !== "model_call" || modelStep.state !== "running") {
      throw new RunNotRecoverableError(claim.run.id, "the current cursor is not resumable yet");
    }
    const persistedCall = claim.modelCalls.find(call => call.stepId === modelStep.id);
    if (persistedCall) return this.resumePersistedModelCall(claim, checkpoint, request, modelStep, persistedCall);
    return this.execute({
      context: claim.run.context,
      model: checkpoint.model,
      prompt: "",
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.maxModelTurns !== undefined ? { maxModelTurns: request.maxModelTurns } : {}),
    }, {
      runId: claim.run.id,
      runRevision: claim.run.revision,
      sequence: (claim.steps.at(-1)?.sequence ?? -1) + 1,
      checkpointVersion: claim.checkpoint.version,
      usage: checkpoint.usage,
      messages: checkpoint.messages,
      modelStep,
      deliveryDestination: checkpoint.deliveryDestination,
    });
  }

  private async resumePendingCursor(
    claim: RecoveryClaim,
    checkpoint: ReturnType<typeof restoredCheckpoint>,
    request: HeadlessResumeRequest,
    step: Step,
  ): Promise<HeadlessRunResult> {
    await this.store.updateExecutionProgress({
      runId: claim.run.id,
      expectedRunRevision: claim.run.revision,
      expectedRunState: "running",
      runState: "running",
      resumeEligibility: "eligible",
      runUpdatedAt: this.now(),
      step: { id: step.id, expectedRevision: step.revision, expectedState: "pending", state: "running", updatedAt: this.now() },
      checkpoint: {
        runId: claim.run.id,
        version: claim.checkpoint.version + 1,
        data: checkpointData(checkpoint.model, checkpoint.messages, checkpoint.usage, checkpoint.deliveryDestination),
        updatedAt: this.now(),
      },
    });
    const running = { ...step, revision: step.revision + 1, state: "running" as const };
    const advanced = {
      ...claim,
      run: { ...claim.run, revision: claim.run.revision + 1 },
      checkpoint: { ...claim.checkpoint, version: claim.checkpoint.version + 1 },
      steps: [...claim.steps.slice(0, -1), running],
    };
    return step.kind === "operation"
      ? this.resumeOperationCursor(advanced, checkpoint, request, running)
      : this.execute({
          context: claim.run.context,
          model: checkpoint.model,
          prompt: "",
          ...(request.signal ? { signal: request.signal } : {}),
          ...(request.maxModelTurns !== undefined ? { maxModelTurns: request.maxModelTurns } : {}),
        }, {
          runId: claim.run.id,
          runRevision: claim.run.revision + 1,
          sequence: step.sequence + 1,
          checkpointVersion: claim.checkpoint.version + 1,
          usage: checkpoint.usage,
          messages: checkpoint.messages,
          modelStep: running,
          deliveryDestination: checkpoint.deliveryDestination,
        });
  }

  private async resumeAfterCompletedModelCall(
    claim: RecoveryClaim,
    checkpoint: ReturnType<typeof restoredCheckpoint>,
    request: HeadlessResumeRequest,
    step: Step,
  ): Promise<HeadlessRunResult> {
    const call = claim.modelCalls.find(candidate => candidate.stepId === step.id);
    if (!call) throw new RunNotRecoverableError(claim.run.id, "completed model Step has no durable response");
    if (call.response.toolCalls.length > 0) {
      return this.appendRecoveryCursor(claim, checkpoint, request, "operation", step.sequence + 1);
    }
    const deliveryId = this.createId("delivery");
    await this.store.completeRunWithOutput({
      output: {
        id: this.createId("output"),
        runId: claim.run.id,
        text: call.response.text,
        usage: checkpoint.usage,
        createdAt: this.now(),
      },
      delivery: {
        id: deliveryId,
        runId: claim.run.id,
        destination: checkpoint.deliveryDestination,
        payload: { text: call.response.text },
        state: "pending",
        createdAt: this.now(),
      },
      expectedRunRevision: claim.run.revision,
      runUpdatedAt: this.now(),
    });
    return { status: "succeeded", runId: claim.run.id, deliveryId, text: call.response.text, usage: checkpoint.usage };
  }

  private async resumeAfterCompletedOperation(
    claim: RecoveryClaim,
    checkpoint: ReturnType<typeof restoredCheckpoint>,
    request: HeadlessResumeRequest,
    step: Step,
  ): Promise<HeadlessRunResult> {
    const assistant = [...checkpoint.messages].reverse().find(
      (message): message is Extract<ModelMessage, { role: "assistant" }> => message.role === "assistant" && Boolean(message.toolCalls?.length),
    );
    const completed = new Set(checkpoint.messages
      .filter((message): message is Extract<ModelMessage, { role: "tool" }> => message.role === "tool")
      .map(message => message.toolCallId));
    const kind = assistant?.toolCalls?.some(call => !completed.has(call.id)) ? "operation" : "model_call";
    return this.appendRecoveryCursor(claim, checkpoint, request, kind, step.sequence + 1);
  }

  private async appendRecoveryCursor(
    claim: RecoveryClaim,
    checkpoint: ReturnType<typeof restoredCheckpoint>,
    request: HeadlessResumeRequest,
    kind: Step["kind"],
    sequence: number,
  ): Promise<HeadlessRunResult> {
    const step = this.newStep(claim.run.id, sequence, kind);
    await this.store.appendStep(step);
    return this.resumePendingCursor({ ...claim, steps: [...claim.steps, step] }, checkpoint, request, step);
  }

  private async resumePersistedModelCall(
    claim: RecoveryClaim,
    checkpoint: ReturnType<typeof restoredCheckpoint>,
    request: HeadlessResumeRequest,
    modelStep: Step,
    persistedCall: RecoveryClaim["modelCalls"][number],
  ): Promise<HeadlessRunResult> {
    const messages = checkpoint.messages;
    messages.push(persistedCall.response.assistantMessage);
    const usage = addUsage(checkpoint.usage, persistedCall.response.usage);
    const progressedAt = this.now();
    await this.store.updateExecutionProgress({
      runId: claim.run.id,
      expectedRunRevision: claim.run.revision,
      expectedRunState: "running",
      runState: "running",
      resumeEligibility: "eligible",
      runUpdatedAt: progressedAt,
      step: {
        id: modelStep.id,
        expectedRevision: modelStep.revision,
        expectedState: "running",
        state: "succeeded",
        updatedAt: progressedAt,
      },
      checkpoint: {
        runId: claim.run.id,
        version: claim.checkpoint.version + 1,
        data: checkpointData(checkpoint.model, messages, usage, checkpoint.deliveryDestination),
        updatedAt: progressedAt,
      },
    });
    if (persistedCall.response.toolCalls.length === 0) {
      const deliveryId = this.createId("delivery");
      await this.store.completeRunWithOutput({
        output: {
          id: this.createId("output"),
          runId: claim.run.id,
          text: persistedCall.response.text,
          usage,
          createdAt: this.now(),
        },
        delivery: {
          id: deliveryId,
          runId: claim.run.id,
          destination: checkpoint.deliveryDestination,
          payload: { text: persistedCall.response.text },
          state: "pending",
          createdAt: this.now(),
        },
        expectedRunRevision: claim.run.revision + 1,
        runUpdatedAt: this.now(),
      });
      return { status: "succeeded", runId: claim.run.id, deliveryId, text: persistedCall.response.text, usage };
    }
    const operationStep = this.newStep(claim.run.id, modelStep.sequence + 1, "operation");
    await this.store.appendStep(operationStep);
    await this.store.updateExecutionProgress({
      runId: claim.run.id,
      expectedRunRevision: claim.run.revision + 1,
      expectedRunState: "running",
      runState: "running",
      resumeEligibility: "eligible",
      runUpdatedAt: this.now(),
      step: { id: operationStep.id, expectedRevision: 0, expectedState: "pending", state: "running", updatedAt: this.now() },
      checkpoint: {
        runId: claim.run.id,
        version: claim.checkpoint.version + 2,
        data: checkpointData(checkpoint.model, messages, usage, checkpoint.deliveryDestination),
        updatedAt: this.now(),
      },
    });
    return this.resumeOperationCursor({
      ...claim,
      run: { ...claim.run, revision: claim.run.revision + 2 },
      checkpoint: {
        runId: claim.run.id,
        version: claim.checkpoint.version + 2,
        data: checkpointData(checkpoint.model, messages, usage, checkpoint.deliveryDestination),
        updatedAt: this.now(),
      },
      steps: [...claim.steps, { ...operationStep, revision: 1, state: "running" }],
    }, { ...checkpoint, messages, usage }, request, { ...operationStep, revision: 1, state: "running" });
  }

  private async resumeOperationCursor(
    claim: RecoveryClaim,
    checkpoint: ReturnType<typeof restoredCheckpoint>,
    request: HeadlessResumeRequest,
    operationStep: Step,
  ): Promise<HeadlessRunResult> {
    const assistant = [...checkpoint.messages].reverse().find(
      (message): message is Extract<ModelMessage, { role: "assistant" }> => message.role === "assistant" && Boolean(message.toolCalls?.length),
    );
    const completedCallIds = new Set(checkpoint.messages
      .filter((message): message is Extract<ModelMessage, { role: "tool" }> => message.role === "tool")
      .map(message => message.toolCallId));
    const call = assistant?.toolCalls?.find(candidate => !completedCallIds.has(candidate.id));
    if (!call) throw new RunNotRecoverableError(claim.run.id, "the operation cursor has no pending tool call");

    const existing = claim.operations.filter(operation => operation.stepId === operationStep.id).at(-1);
    const persisted = existing ? await this.store.getOperationResult(existing.id) : undefined;
    const retryInterruptedPure = existing?.sideEffect === "none"
      && persisted?.error?.code === "process_interrupted";
    const toolResult = persisted && !retryInterruptedPure && persisted.outcome !== "outcome_unknown"
      ? this.projectOperationResult(persisted)
      : await this.invokeTool(call, claim.run.id, operationStep.id, claim.run.context, request.signal);

    if (toolResult.status === "outcome_unknown") {
      await this.store.updateExecutionProgress({
        runId: claim.run.id,
        expectedRunRevision: claim.run.revision,
        expectedRunState: "running",
        runState: "waiting",
        waitingReason: "operation_outcome_unknown",
        resumeEligibility: "manual_review",
        runUpdatedAt: this.now(),
        step: {
          id: operationStep.id,
          expectedRevision: operationStep.revision,
          expectedState: "running",
          state: "failed",
          updatedAt: this.now(),
        },
        checkpoint: {
          runId: claim.run.id,
          version: claim.checkpoint.version + 1,
          data: checkpointData(checkpoint.model, checkpoint.messages, checkpoint.usage, checkpoint.deliveryDestination),
          updatedAt: this.now(),
        },
      });
      return { status: "waiting", runId: claim.run.id, reason: "outcome_unknown" };
    }
    if (toolResult.status === "cancelled") {
      await this.store.updateExecutionProgress({
        runId: claim.run.id,
        expectedRunRevision: claim.run.revision,
        expectedRunState: "running",
        runState: "cancelled",
        resumeEligibility: "ineligible",
        runUpdatedAt: this.now(),
        step: {
          id: operationStep.id,
          expectedRevision: operationStep.revision,
          expectedState: "running",
          state: "cancelled",
          updatedAt: this.now(),
        },
        clearCheckpoint: true,
      });
      return { status: "cancelled", runId: claim.run.id, error: toolResult.error.message };
    }
    const payload = toolResult.status === "succeeded"
      ? { ok: true, output: toolResult.output }
      : { ok: false, error: toolResult.error };
    const messages = checkpoint.messages;
    messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify(payload) });
    const progressedAt = this.now();
    await this.store.updateExecutionProgress({
      runId: claim.run.id,
      expectedRunRevision: claim.run.revision,
      expectedRunState: "running",
      runState: "running",
      resumeEligibility: "eligible",
      runUpdatedAt: progressedAt,
      step: {
        id: operationStep.id,
        expectedRevision: operationStep.revision,
        expectedState: "running",
        state: "succeeded",
        updatedAt: progressedAt,
      },
      checkpoint: {
        runId: claim.run.id,
        version: claim.checkpoint.version + 1,
        data: checkpointData(checkpoint.model, messages, checkpoint.usage, checkpoint.deliveryDestination),
        updatedAt: progressedAt,
      },
    });
    const remainingCall = assistant?.toolCalls?.find(candidate => !completedCallIds.has(candidate.id) && candidate.id !== call.id);
    const nextStep = this.newStep(claim.run.id, operationStep.sequence + 1, remainingCall ? "operation" : "model_call");
    await this.store.appendStep(nextStep);
    await this.store.updateExecutionProgress({
      runId: claim.run.id,
      expectedRunRevision: claim.run.revision + 1,
      expectedRunState: "running",
      runState: "running",
      resumeEligibility: "eligible",
      runUpdatedAt: this.now(),
      step: { id: nextStep.id, expectedRevision: 0, expectedState: "pending", state: "running", updatedAt: this.now() },
      checkpoint: {
        runId: claim.run.id,
        version: claim.checkpoint.version + 2,
        data: checkpointData(checkpoint.model, messages, checkpoint.usage, checkpoint.deliveryDestination),
        updatedAt: this.now(),
      },
    });
    if (remainingCall) {
      return this.resumeOperationCursor({
        ...claim,
        run: { ...claim.run, revision: claim.run.revision + 2 },
        checkpoint: {
          runId: claim.run.id,
          version: claim.checkpoint.version + 2,
          data: checkpointData(checkpoint.model, messages, checkpoint.usage, checkpoint.deliveryDestination),
          updatedAt: this.now(),
        },
        steps: [...claim.steps, { ...nextStep, revision: 1, state: "running" }],
        operations: await this.store.listOperations(claim.run.id),
      }, checkpoint, request, { ...nextStep, revision: 1, state: "running" });
    }
    return this.execute({
      context: claim.run.context,
      model: checkpoint.model,
      prompt: "",
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.maxModelTurns !== undefined ? { maxModelTurns: request.maxModelTurns } : {}),
    }, {
      runId: claim.run.id,
      runRevision: claim.run.revision + 2,
      sequence: nextStep.sequence + 1,
      checkpointVersion: claim.checkpoint.version + 2,
      usage: checkpoint.usage,
      messages,
      modelStep: nextStep,
      deliveryDestination: checkpoint.deliveryDestination,
    });
  }

  private projectOperationResult(result: OperationResult) {
    if (result.outcome === "succeeded") {
      return { status: "succeeded" as const, operationId: result.operationId, output: result.output ?? null };
    }
    return {
      status: result.outcome,
      operationId: result.operationId,
      error: result.error ?? { code: "operation_failed", message: "operation failed", retryable: false },
      ...(result.output !== undefined ? { output: result.output } : {}),
    };
  }

  private invokeTool(call: ModelToolCall, runId: string, stepId: string, context: ExecutionContext, signal?: AbortSignal) {
    if (call.argumentError) {
      return Promise.resolve({
        status: "invalid_input" as const,
        error: { code: "malformed_tool_arguments", message: call.argumentError, retryable: false },
      });
    }
    return this.toolRuntime.execute({
      toolName: call.name,
      input: call.input,
      stepId,
      context,
      runId,
      ...(this.tools.get(call.name)?.policy.sideEffect === "idempotent"
        ? { idempotencyKey: `${runId}:${call.id}` }
        : {}),
      ...(signal ? { signal } : {}),
    });
  }

  private async execute(request: HeadlessRunRequest, restored?: RestoredExecution): Promise<HeadlessRunResult> {
    validateRunLimits(request);
    const runId = restored?.runId ?? request.runId ?? this.createId("run");
    let runRevision = restored?.runRevision ?? 0;
    let sequence = restored?.sequence ?? 0;
    let checkpointVersion = restored?.checkpointVersion ?? 0;
    let usage = restored?.usage ?? ZERO_USAGE;
    const deliveryDestination = restored?.deliveryDestination ?? request.deliveryDestination ?? { kind: "caller" };
    const messages: ModelMessage[] = restored?.messages ?? initialMessages(request);
    let modelStep = restored?.modelStep ?? this.newStep(runId, sequence++, "model_call");
    if (!restored) {
      const startedAt = this.now();
      const run: Run = {
        id: runId,
        revision: 0,
        state: "queued",
        context: request.context,
        ...(request.conversationId ? { conversationId: request.conversationId } : {}),
        ...(request.turnId ? { turnId: request.turnId } : {}),
        resumeEligibility: "eligible",
        createdAt: startedAt,
        updatedAt: startedAt,
      };
      await this.store.createRunWithStep(run, modelStep);
      await this.store.updateExecutionProgress({
        runId,
        expectedRunRevision: runRevision,
        expectedRunState: "queued",
        runState: "running",
        resumeEligibility: "eligible",
        runUpdatedAt: this.now(),
        step: { id: modelStep.id, expectedRevision: 0, expectedState: "pending", state: "running", updatedAt: this.now() },
        checkpoint: { runId, version: checkpointVersion + 1, data: checkpointData(request.model, messages, usage, deliveryDestination), updatedAt: this.now() },
      });
      runRevision += 1;
      checkpointVersion += 1;
    }

    const maxModelTurns = request.maxModelTurns ?? 8;
    let toolCalls = 0;
    const startedMs = Date.now();
    const durationError = request.maxDurationMs === undefined ? undefined : new Error(`run duration budget exceeded: ${request.maxDurationMs}ms`);
    const durationController = durationError ? new AbortController() : undefined;
    const durationTimer = durationController && request.maxDurationMs !== undefined
      ? setTimeout(() => durationController.abort(durationError), request.maxDurationMs)
      : undefined;
    const runSignal = durationController
      ? request.signal ? AbortSignal.any([request.signal, durationController.signal]) : durationController.signal
      : request.signal;
    const assertBudget = (beforeModel = false) => {
      if (durationController?.signal.aborted || (request.maxDurationMs !== undefined && Date.now() - startedMs >= request.maxDurationMs)) throw durationError;
      if (request.maxInputTokens !== undefined && (beforeModel ? usage.inputTokens >= request.maxInputTokens : usage.inputTokens > request.maxInputTokens)) throw new Error(`input token budget exceeded: ${request.maxInputTokens}`);
      if (request.maxOutputTokens !== undefined && (beforeModel ? usage.outputTokens >= request.maxOutputTokens : usage.outputTokens > request.maxOutputTokens)) throw new Error(`output token budget exceeded: ${request.maxOutputTokens}`);
    };
    try {
      for (let turn = 0; turn < maxModelTurns; turn += 1) {
        assertBudget(true);
        const response = await this.modelPort.generate({
          model: request.model,
          messages,
          tools: this.tools.modelDefinitions(),
          ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: Math.max(1, request.maxOutputTokens - usage.outputTokens) } : {}),
          ...(runSignal ? { signal: runSignal } : {}),
        });
        usage = addUsage(usage, response.usage);
        await this.store.recordModelCall({
          id: this.createId("model_call"), runId, stepId: modelStep.id, model: request.model,
          messages: structuredClone(messages), response, createdAt: this.now(),
        });
        messages.push(response.assistantMessage);
        await this.store.updateExecutionProgress({
          runId,
          expectedRunRevision: runRevision,
          expectedRunState: "running",
          runState: "running",
          resumeEligibility: "eligible",
          runUpdatedAt: this.now(),
          step: { id: modelStep.id, expectedRevision: 1, expectedState: "running", state: "succeeded", updatedAt: this.now() },
          checkpoint: { runId, version: checkpointVersion + 1, data: checkpointData(request.model, messages, usage, deliveryDestination), updatedAt: this.now() },
        });
        runRevision += 1;
        checkpointVersion += 1;
        assertBudget();

        if (response.toolCalls.length === 0) {
          const completedAt = this.now();
          const deliveryId = this.createId("delivery");
          await this.store.completeRunWithOutput({
            output: { id: this.createId("output"), runId, text: response.text, usage, createdAt: completedAt },
            delivery: {
              id: deliveryId,
              runId,
              destination: deliveryDestination,
              payload: { text: response.text },
              state: "pending",
              createdAt: completedAt,
            },
            expectedRunRevision: runRevision,
            runUpdatedAt: completedAt,
          });
          return { status: "succeeded", runId, deliveryId, text: response.text, usage };
        }

        for (const call of response.toolCalls) {
          toolCalls += 1;
          if (request.maxToolCalls !== undefined && toolCalls > request.maxToolCalls) throw new Error(`tool call budget exceeded: ${request.maxToolCalls}`);
          const toolStep = this.newStep(runId, sequence++, "operation");
          await this.store.appendStep(toolStep);
          await this.store.updateExecutionProgress({
            runId,
            expectedRunRevision: runRevision,
            expectedRunState: "running",
            runState: "running",
            resumeEligibility: "eligible",
            runUpdatedAt: this.now(),
            step: { id: toolStep.id, expectedRevision: 0, expectedState: "pending", state: "running", updatedAt: this.now() },
            checkpoint: { runId, version: checkpointVersion + 1, data: checkpointData(request.model, messages, usage, deliveryDestination), updatedAt: this.now() },
          });
          runRevision += 1;
          checkpointVersion += 1;
          const toolResult = call.argumentError
            ? { status: "invalid_input" as const, error: { code: "malformed_tool_arguments", message: call.argumentError, retryable: false } }
            : await this.toolRuntime.execute({
                toolName: call.name, input: call.input, stepId: toolStep.id, context: request.context,
                ...(this.tools.get(call.name)?.policy.sideEffect === "idempotent"
                  ? { idempotencyKey: `${runId}:${call.id}` }
                  : {}),
                ...(runSignal ? { signal: runSignal } : {}),
              });
          if (durationController?.signal.aborted) throw durationError;
          const stepState = toolResult.status === "cancelled" ? "cancelled" : toolResult.status === "outcome_unknown" ? "failed" : "succeeded";
          const payload = toolResult.status === "succeeded"
            ? { ok: true, output: toolResult.output }
            : { ok: false, error: toolResult.error };
          if (toolResult.status !== "outcome_unknown" && toolResult.status !== "cancelled") {
            messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify(payload) });
          }
          await this.store.updateExecutionProgress({
            runId,
            expectedRunRevision: runRevision,
            expectedRunState: "running",
            runState: toolResult.status === "outcome_unknown" ? "waiting" : toolResult.status === "cancelled" ? "cancelled" : "running",
            resumeEligibility: toolResult.status === "outcome_unknown" ? "manual_review" : toolResult.status === "cancelled" ? "ineligible" : "eligible",
            ...(toolResult.status === "outcome_unknown" ? { waitingReason: "operation_outcome_unknown" } : {}),
            runUpdatedAt: this.now(),
            step: { id: toolStep.id, expectedRevision: 1, expectedState: "running", state: stepState, updatedAt: this.now() },
            checkpoint: { runId, version: checkpointVersion + 1, data: checkpointData(request.model, messages, usage, deliveryDestination), updatedAt: this.now() },
          });
          runRevision += 1;
          checkpointVersion += 1;
          if (toolResult.status === "outcome_unknown") return { status: "waiting", runId, reason: "outcome_unknown" };
          if (toolResult.status === "cancelled") return { status: "cancelled", runId, error: toolResult.error.message };
        }

        modelStep = this.newStep(runId, sequence++, "model_call");
        await this.store.appendStep(modelStep);
        await this.store.updateExecutionProgress({
          runId,
          expectedRunRevision: runRevision,
          expectedRunState: "running",
          runState: "running",
          resumeEligibility: "eligible",
          runUpdatedAt: this.now(),
          step: { id: modelStep.id, expectedRevision: 0, expectedState: "pending", state: "running", updatedAt: this.now() },
          checkpoint: { runId, version: checkpointVersion + 1, data: checkpointData(request.model, messages, usage, deliveryDestination), updatedAt: this.now() },
        });
        runRevision += 1;
        checkpointVersion += 1;
      }
      throw new Error(`model turn limit exceeded: ${maxModelTurns}`);
    } catch (caught) {
      // A stale worker must never overwrite progress committed by the winner.
      if (caught instanceof ExecutionStoreConflictError) throw caught;
      const message = caught instanceof Error ? caught.message : String(caught);
      const cancelled = request.signal?.aborted === true;
      await this.store.updateExecutionProgress({
        runId,
        expectedRunRevision: runRevision,
        expectedRunState: "running",
        runState: cancelled ? "cancelled" : "failed",
        resumeEligibility: "ineligible",
        runUpdatedAt: this.now(),
        clearCheckpoint: true,
      });
      return { status: cancelled ? "cancelled" : "failed", runId, error: message };
    } finally {
      if (durationTimer) clearTimeout(durationTimer);
    }
  }

  private newStep(runId: string, sequence: number, kind: Step["kind"]): Step {
    const now = this.now();
    return { id: this.createId("step"), runId, revision: 0, sequence, kind, state: "pending", createdAt: now, updatedAt: now };
  }
}
