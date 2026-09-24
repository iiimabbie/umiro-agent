import type { ModelContent, ModelFunctionTool, ModelMessage, ModelPort, ModelToolCall, ModelUsage, ReasoningEffort } from "../model/contract.js";
import type { OperationResult } from "../operation/result.js";
import { ExecutionStoreConflictError, type ExecutionStore } from "../ports/execution-store.js";
import type { JsonObject, JsonValue } from "../ports/json.js";
import { ToolRegistry, ToolRuntime } from "../tool/index.js";
import type { ExecutionContext } from "../identity/execution-context.js";
import { intersectAuthority } from "../authorization/authority.js";
import { authorize } from "../authorization/authorize.js";
import { renderContextAssembly, type ContextAssembly } from "../context/index.js";
import type { Run, Step } from "./entities.js";
import { RunNotRecoverableError, type RecoveryClaim } from "./recovery.js";
import { estimateModelMessageTokens, estimateModelRequestTokens } from "../model/estimate.js";

export interface HeadlessRunRequest {
  readonly context: ExecutionContext;
  readonly model: string;
  readonly reasoningEffort?: ReasoningEffort;
  readonly prompt: string;
  /** Optional multimodal user content; when absent, prompt is sent as text. */
  readonly userContent?: ModelContent;
  /** Native historical user/assistant messages, oldest first. */
  readonly history?: readonly ModelMessage[];
  /** Overall initial model-input token ceiling, including context and history. */
  readonly maxContextTokens?: number;
  /** Reports history omitted by the overall input budget. */
  readonly onContextOmission?: (details: { readonly omittedHistoryMessages: number; readonly retainedHistoryMessages: number; readonly truncatedHistoryMessages: number }) => void;
  readonly signal?: AbortSignal;
  readonly onTextDelta?: (delta: string) => void | Promise<void>;
  /** Adapter-owned live ingress gate. flush waits for accepted writes; seal first
   * stops accepting new steer before the final delivery boundary. */
  readonly steerControl?: { readonly flush: () => Promise<void>; readonly seal: () => Promise<void> };
  readonly maxModelTurns?: number;
  readonly maxToolCalls?: number;
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
  readonly maxDurationMs?: number;
  readonly deliveryDestination?: JsonObject;
  readonly conversationId?: string;
  readonly turnId?: string;
  readonly assembledContext?: ContextAssembly;
  /** Analyzer-selected model-visible tools; undefined makes every registered tool visible. */
  readonly visibleToolNames?: readonly string[];
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
  | { readonly status: "failed" | "cancelled"; readonly runId: string; readonly error: string; readonly failure?: RunFailureMetadata };

export type RunFailureCategory = "context_budget" | "model_provider" | "run_cancelled" | "limit" | "processing";
export interface RunFailureMetadata {
  readonly category: RunFailureCategory;
  readonly errorName: string;
  readonly status?: number;
  readonly retryable?: boolean;
}

export interface HeadlessRunEngineOptions {
  readonly now?: () => string;
  readonly createId?: (kind: "run" | "step" | "model_call" | "output" | "delivery" | "operation" | "authorization") => string;
  readonly maxParallelToolCalls?: number;
  readonly resolveModelInputArtifacts?: (input: { readonly artifactIds: readonly string[]; readonly context: ExecutionContext; readonly model: string }) => Promise<ModelContent>;
}

const ZERO_USAGE: ModelUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
const DEFAULT_MAX_MODEL_TURNS = 50;

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as { readonly [key: string]: JsonValue };
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key]!)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function finalModelTurnReminder(maxModelTurns: number): ModelMessage {
  return {
    role: "system",
    content: `This is the final allowed model turn (${maxModelTurns} of ${maxModelTurns}). Do not call any more tools. Give the best complete final response now using the evidence already collected, and state any unresolved limitations clearly.`,
  };
}

export class ModelContextBudgetError extends Error {
  override readonly name = "ModelContextBudgetError";
  constructor(readonly maxContextTokens: number) { super(`model context budget exceeded: ${maxContextTokens}`); }
}

function messageTokens(message: ModelMessage): number {
  return estimateModelMessageTokens(message);
}

export function compactModelMessages(messages: readonly ModelMessage[], tools: readonly ModelFunctionTool[], maxContextTokens: number): ModelMessage[] {
  if (!Number.isSafeInteger(maxContextTokens) || maxContextTokens <= 0) throw new TypeError("maxContextTokens must be a positive safe integer");
  let working = messages.map(message => structuredClone(message));
  const cost = () => estimateModelRequestTokens(working, tools);
  if (cost() <= maxContextTokens) return working;

  // Remove the oldest completed assistant/tool cycle as a unit before
  // truncating recent evidence. This cannot create an orphan tool message or
  // split a multi-call assistant response.
  while (cost() > maxContextTokens) {
    let removed = false;
    const cycles: Array<{ readonly index: number; readonly matching: readonly number[] }> = [];
    for (let index = 0; index < working.length; index += 1) {
      const assistant = working[index];
      if (assistant?.role !== "assistant" || !assistant.toolCalls?.length) continue;
      const ids = assistant.toolCalls.map(call => call.id);
      const matching = working.map((message, messageIndex) => message.role === "tool" && ids.includes(message.toolCallId) ? messageIndex : -1).filter(messageIndex => messageIndex >= 0);
      if (matching.length !== ids.length) continue;
      cycles.push({ index, matching });
    }
    // Keep the newest complete cycle: it is the latest necessary pairing for
    // the next call. If it alone cannot fit, fail locally instead of sending
    // an invalid orphaned tool transcript.
    for (const { index, matching } of cycles.slice(0, -1)) {
      const remove = new Set([index, ...matching]);
      working = working.filter((_message, messageIndex) => !remove.has(messageIndex));
      removed = true;
      break;
    }
    if (!removed) break;
  }
  if (cost() <= maxContextTokens) return working;

  // Full tool results remain durable in OperationResult. Preserve the newest
  // evidence for as long as possible, shortening older/larger projections
  // only after removable completed cycles have been discarded.
  const toolIndexes = working.map((message, index) => ({ message, index })).filter(item => item.message.role === "tool")
    .sort((left, right) => left.index - right.index || (right.message.role === "tool" ? right.message.content.length : 0) - (left.message.role === "tool" ? left.message.content.length : 0));
  for (const { index } of toolIndexes) {
    const message = working[index];
    if (!message || message.role !== "tool" || cost() <= maxContextTokens) break;
    const marker = "\n[tool output truncated]";
    let low = 0;
    let high = message.content.length;
    let best = "";
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const head = Math.ceil(middle * 0.7);
      const tail = middle - head;
      const candidate = `${message.content.slice(0, head)}${middle < message.content.length ? marker : ""}${tail ? message.content.slice(-tail) : ""}`;
      const next = [...working];
      next[index] = { ...message, content: candidate };
      if (estimateModelRequestTokens(next, tools) <= maxContextTokens) { best = candidate; low = middle + 1; } else high = middle - 1;
    }
    working[index] = { ...message, content: best || marker };
  }
  if (cost() > maxContextTokens) throw new ModelContextBudgetError(maxContextTokens);
  return working;
}

function replaceMessages(target: ModelMessage[], next: readonly ModelMessage[]): void {
  target.splice(0, target.length, ...next);
}

function messageBudget(maxContextTokens: number | undefined, tools: readonly ModelFunctionTool[]): number | undefined {
  if (maxContextTokens === undefined) return undefined;
  return Math.max(1, maxContextTokens - estimateModelRequestTokens([], tools));
}

function projectModelMessagesForAudit(messages: readonly ModelMessage[]): ModelMessage[] {
  return messages.map(message => {
    if (message.role !== "user" || typeof message.content === "string") return structuredClone(message);
    return {
      ...message,
      content: message.content.map(part => part.type === "image"
        ? { ...part, url: "[image data omitted from audit]" }
        : part.type === "file"
          ? { ...part, data: "[file data omitted from audit]" }
          : part),
    };
  });
}

function truncateHistoricalMessage(message: ModelMessage, availableTokens: number): ModelMessage | undefined {
  if (message.role !== "user" || typeof message.content !== "string" || availableTokens <= 0) return undefined;
  const marker = "\n[history truncated]";
  if (messageTokens(message) <= availableTokens) return message;
  const candidate = (length: number): ModelMessage => {
    const head = Math.max(1, Math.ceil(length * 0.65));
    const tail = Math.max(0, length - head);
    return { role: "user", content: `${message.content.slice(0, head)}${marker}${tail ? message.content.slice(-tail) : ""}` };
  };
  let low = 0;
  let high = message.content.length;
  let best: ModelMessage | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidateMessage = candidate(middle);
    if (messageTokens(candidateMessage) <= availableTokens) {
      best = candidateMessage;
      low = middle + 1;
    } else high = middle - 1;
  }
  return best;
}

export function buildInitialMessages(request: Pick<HeadlessRunRequest, "prompt" | "userContent" | "assembledContext" | "history" | "maxContextTokens" | "onContextOmission">): ModelMessage[] {
  const system = request.assembledContext?.blocks.length
    ? { role: "system" as const, content: renderContextAssembly(request.assembledContext) }
    : undefined;
  const current = { role: "user" as const, content: request.userContent ?? request.prompt };
  const history = [...(request.history ?? [])].filter(message => message.role === "user" || message.role === "assistant");
  if (request.maxContextTokens === undefined || history.length === 0) return [...(system ? [system] : []), ...history, current];

  const fixedTokens = (system ? messageTokens(system) : 0) + messageTokens(current);
  let available = Math.max(0, request.maxContextTokens - fixedTokens);
  const groups: ModelMessage[][] = [];
  for (const message of history) {
    if (message.role === "user") groups.push([message]);
    else if (groups.length) groups.at(-1)!.push(message);
  }
  const retained: ModelMessage[][] = [];
  let truncatedHistoryMessages = 0;
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index]!;
    const cost = group.reduce((total, message) => total + messageTokens(message), 0);
    if (cost <= available) {
      retained.unshift(group);
      available -= cost;
      continue;
    }
    const truncated = truncateHistoricalMessage(group[0]!, available);
    if (truncated) {
      retained.unshift([truncated]);
      truncatedHistoryMessages += 1;
    }
    break;
  }
  const retainedMessages = retained.flat();
  const omittedHistoryMessages = history.length - retainedMessages.length;
  if (omittedHistoryMessages > 0 || truncatedHistoryMessages > 0) request.onContextOmission?.({ omittedHistoryMessages, retainedHistoryMessages: retainedMessages.length, truncatedHistoryMessages });
  return [...(system ? [system] : []), ...retainedMessages, current];
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
    maxContextTokens: request.maxContextTokens,
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

function checkpointData(model: string, messages: readonly ModelMessage[], usage: ModelUsage, deliveryDestination: JsonObject, reasoningEffort?: ReasoningEffort, maxContextTokens?: number, visibleToolNames?: readonly string[]): JsonValue {
  return JSON.parse(JSON.stringify({ version: 2, model, ...(reasoningEffort ? { reasoningEffort } : {}), ...(maxContextTokens !== undefined ? { maxContextTokens } : {}), ...(visibleToolNames !== undefined ? { visibleToolNames: [...visibleToolNames] } : {}), messages, usage, deliveryDestination })) as JsonValue;
}

function restoredCheckpoint(claim: RecoveryClaim): { model: string; reasoningEffort?: ReasoningEffort; maxContextTokens?: number; visibleToolNames?: string[]; messages: ModelMessage[]; usage: ModelUsage; deliveryDestination: JsonObject } {
  const data = claim.checkpoint.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new RunNotRecoverableError(claim.run.id, "checkpoint payload is invalid");
  }
  const payload = data as Record<string, JsonValue>;
  const model = payload.model;
  const messages = payload.messages;
  const reasoningEffort = payload.reasoningEffort;
  const maxContextTokens = payload.maxContextTokens;
  const visibleToolNames = payload.visibleToolNames;
  const usage = payload.usage;
  const deliveryDestination = payload.deliveryDestination;
  const usageRecord = usage && typeof usage === "object" && !Array.isArray(usage)
    ? usage as Record<string, JsonValue>
    : undefined;
  if (payload.version !== 2 || typeof model !== "string" || !Array.isArray(messages)
    || (reasoningEffort !== undefined && !["default", "low", "medium", "high", "xhigh"].includes(String(reasoningEffort)))
    || (maxContextTokens !== undefined && (typeof maxContextTokens !== "number" || !Number.isSafeInteger(maxContextTokens) || maxContextTokens <= 0))
    || !usageRecord || (deliveryDestination !== undefined
      && (!deliveryDestination || typeof deliveryDestination !== "object" || Array.isArray(deliveryDestination)))
    || typeof usageRecord.inputTokens !== "number" || typeof usageRecord.outputTokens !== "number"
    || typeof usageRecord.reasoningTokens !== "number"
    || (visibleToolNames !== undefined && (!Array.isArray(visibleToolNames) || visibleToolNames.some(name => typeof name !== "string" || !/^[a-z][a-z0-9_.-]{0,127}$/.test(name)) || new Set(visibleToolNames).size !== visibleToolNames.length))) {
    throw new RunNotRecoverableError(claim.run.id, "checkpoint payload has an unsupported shape");
  }
  return {
    model,
    ...(reasoningEffort !== undefined ? { reasoningEffort: reasoningEffort as ReasoningEffort } : {}),
    ...(maxContextTokens !== undefined ? { maxContextTokens } : {}),
    ...(Array.isArray(visibleToolNames) ? { visibleToolNames: [...visibleToolNames] } : {}),
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
  readonly maxContextTokens?: number;
  readonly visibleToolNames?: readonly string[];
}

export class HeadlessRunEngine {
  private readonly now: () => string;
  private readonly createId: NonNullable<HeadlessRunEngineOptions["createId"]>;
  private readonly toolRuntime: ToolRuntime;
  private maxParallelToolCalls: number;
  private readonly resolveModelInputArtifacts?: HeadlessRunEngineOptions["resolveModelInputArtifacts"];

  constructor(
    private readonly modelPort: ModelPort,
    private readonly tools: ToolRegistry,
    private readonly store: ExecutionStore,
    options: HeadlessRunEngineOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? ((_kind) => crypto.randomUUID());
    this.maxParallelToolCalls = options.maxParallelToolCalls ?? 2;
    this.resolveModelInputArtifacts = options.resolveModelInputArtifacts;
    if (!Number.isSafeInteger(this.maxParallelToolCalls) || this.maxParallelToolCalls <= 0) throw new TypeError("maxParallelToolCalls must be a positive safe integer");
    this.toolRuntime = new ToolRuntime(tools, store, { now: this.now, createId: kind => this.createId(kind) });
  }

  setMaxParallelToolCalls(value: number): void {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError("maxParallelToolCalls must be a positive safe integer");
    this.maxParallelToolCalls = value;
  }

  private async artifactIdsForRun(runId: string): Promise<readonly string[]> {
    const ids = new Set<string>();
    for (const operation of await this.store.listOperations(runId)) {
      const result = await this.store.getOperationResult(operation.id);
      for (const id of result?.artifactIds ?? []) if (typeof id === "string" && id) ids.add(id);
    }
    return [...ids];
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
    const initialMessageBudget = messageBudget(request.maxContextTokens, this.tools.modelDefinitions(request.visibleToolNames));
    const messages = buildInitialMessages({ ...request, ...(initialMessageBudget !== undefined ? { maxContextTokens: initialMessageBudget } : {}) });
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
        data: checkpointData(request.model, messages, ZERO_USAGE, deliveryDestination, request.reasoningEffort, request.maxContextTokens, request.visibleToolNames),
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
      ...(request.maxContextTokens !== undefined ? { maxContextTokens: request.maxContextTokens } : {}),
      ...(request.visibleToolNames !== undefined ? { visibleToolNames: request.visibleToolNames } : {}),
    });
  }

  async resume(claim: RecoveryClaim, request: HeadlessResumeRequest = {}): Promise<HeadlessRunResult> {
    if (claim.run.state !== "running" || claim.run.resumeEligibility !== "eligible") {
      throw new RunNotRecoverableError(claim.run.id, "the Run has not been claimed");
    }
    const modelStep = claim.steps.find(step => step.state === "pending" || step.state === "running") ?? claim.steps.at(-1);
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
      ...(checkpoint.reasoningEffort ? { reasoningEffort: checkpoint.reasoningEffort } : {}),
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
      ...(checkpoint.maxContextTokens !== undefined ? { maxContextTokens: checkpoint.maxContextTokens } : {}),
      ...(checkpoint.visibleToolNames !== undefined ? { visibleToolNames: checkpoint.visibleToolNames } : {}),
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
        data: checkpointData(checkpoint.model, checkpoint.messages, checkpoint.usage, checkpoint.deliveryDestination, checkpoint.reasoningEffort, checkpoint.maxContextTokens, checkpoint.visibleToolNames),
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
          ...(checkpoint.reasoningEffort ? { reasoningEffort: checkpoint.reasoningEffort } : {}),
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
          ...(checkpoint.maxContextTokens !== undefined ? { maxContextTokens: checkpoint.maxContextTokens } : {}),
          ...(checkpoint.visibleToolNames !== undefined ? { visibleToolNames: checkpoint.visibleToolNames } : {}),
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
    const artifactIds = await this.artifactIdsForRun(claim.run.id);
    await this.store.completeRunWithOutput({
      output: {
        id: this.createId("output"),
        runId: claim.run.id,
        text: call.response.text,
        usage: checkpoint.usage,
        createdAt: this.now(),
        ...(artifactIds.length ? { artifactIds } : {}),
      },
      delivery: {
        id: deliveryId,
        runId: claim.run.id,
        destination: checkpoint.deliveryDestination,
        payload: { text: call.response.text, ...(artifactIds.length ? { artifactIds } : {}) },
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
        data: checkpointData(checkpoint.model, messages, usage, checkpoint.deliveryDestination, checkpoint.reasoningEffort, checkpoint.maxContextTokens, checkpoint.visibleToolNames),
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
        data: checkpointData(checkpoint.model, messages, usage, checkpoint.deliveryDestination, checkpoint.reasoningEffort, checkpoint.maxContextTokens, checkpoint.visibleToolNames),
        updatedAt: this.now(),
      },
    });
    return this.resumeOperationCursor({
      ...claim,
      run: { ...claim.run, revision: claim.run.revision + 2 },
      checkpoint: {
        runId: claim.run.id,
        version: claim.checkpoint.version + 2,
        data: checkpointData(checkpoint.model, messages, usage, checkpoint.deliveryDestination, checkpoint.reasoningEffort, checkpoint.maxContextTokens, checkpoint.visibleToolNames),
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
    const routed = this.resolveCatalogCall(call, claim.run.context);
    const invocationName = routed?.toolName ?? call.name;
    const invocationInput = routed?.input ?? call.input;
    const mismatch = routed && !routed.error && existing && (existing.kind !== `tool:${invocationName}` || canonicalJson(existing.input) !== canonicalJson(invocationInput as JsonObject) || existing.stepId !== operationStep.id);
    const toolResult = mismatch
      ? { status: "invalid_input" as const, error: { code: "operation_mismatch", message: "stored operation does not match the pending catalog call", retryable: false } }
      : !routed && !this.isVisibleTool(call.name, checkpoint.visibleToolNames)
      ? this.hiddenToolResult(call.name)
      : routed?.error
        ? { status: "invalid_input" as const, error: { code: routed.error, message: routed.message!, retryable: false } }
      : persisted?.outcome === "outcome_unknown" && existing?.sideEffect !== "none"
        && !(existing?.sideEffect === "idempotent" && existing.idempotencyKey?.trim())
        ? this.projectOperationResult(persisted)
      : persisted && !retryInterruptedPure && persisted.outcome !== "outcome_unknown"
      ? this.projectOperationResult(persisted)
      : existing?.state === "authorized"
        ? await this.toolRuntime.resume(existing.id, { toolName: invocationName, input: invocationInput, stepId: operationStep.id, context: claim.run.context, runId: claim.run.id, ...(request.signal ? { signal: request.signal } : {}) })
        : await this.invokeTool(call, claim.run.id, operationStep.id, claim.run.context, request.signal, checkpoint.visibleToolNames);

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
          data: checkpointData(checkpoint.model, checkpoint.messages, checkpoint.usage, checkpoint.deliveryDestination, checkpoint.reasoningEffort, checkpoint.maxContextTokens, checkpoint.visibleToolNames),
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
    const remainingCall = assistant?.toolCalls?.find(candidate => !completedCallIds.has(candidate.id) && candidate.id !== call.id);
    const payload = toolResult.status === "succeeded"
      ? { ok: true, output: toolResult.output }
      : { ok: false, error: toolResult.error };
    const messages = checkpoint.messages;
    messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify(payload) });
    if (!remainingCall) {
      const modelInputArtifactIds = new Set<string>(toolResult.status === "succeeded" ? (toolResult.modelInputArtifactIds ?? []) : []);
      // A crash may leave earlier parallel operations durable while their tool
      // messages are not yet in the checkpoint. Rebuild IDs from only the
      // operation steps belonging to this assistant batch.
      const modelCallRecord = assistant ? claim.modelCalls.find(candidate => candidate.response.toolCalls.length === assistant.toolCalls?.length && candidate.response.toolCalls.every((toolCall, index) => toolCall.id === assistant.toolCalls?.[index]?.id)) : undefined;
      const modelCallStep = modelCallRecord ? claim.steps.find(candidate => candidate.id === modelCallRecord.stepId) : undefined;
      const batchSteps = modelCallStep
        ? claim.steps.filter(candidate => candidate.kind === "operation" && candidate.sequence > modelCallStep.sequence && candidate.sequence < (claim.steps.find(next => next.kind === "model_call" && next.sequence > modelCallStep.sequence)?.sequence ?? Number.POSITIVE_INFINITY))
        : [];
      for (const batchStep of batchSteps) {
        const operation = claim.operations.filter(candidate => candidate.stepId === batchStep.id).at(-1);
        if (!operation || operation.id === (existing?.id ?? "")) continue;
        const result = await this.store.getOperationResult(operation.id);
        for (const id of result?.modelInputArtifactIds ?? []) modelInputArtifactIds.add(id);
      }
      const assistantIndex = messages.findLastIndex(message => message.role === "assistant" && message.toolCalls?.some(toolCall => assistant?.toolCalls?.some(current => current.id === toolCall.id)));
      const alreadyInjected = messages.slice(Math.max(0, assistantIndex + 1)).some(message => message.role === "user" && (typeof message.content === "string" ? message.content.startsWith("[Workspace attachment loaded by tool]") : message.content.some(part => part.type === "text" && part.text === "[Workspace attachment loaded by tool]")));
      if (modelInputArtifactIds.size > 0 && !alreadyInjected) {
        if (!this.resolveModelInputArtifacts) throw new Error("model input artifacts cannot be resolved by this runtime");
        const content = await this.resolveModelInputArtifacts({ artifactIds: [...modelInputArtifactIds], context: claim.run.context, model: checkpoint.model });
        messages.push({ role: "user", content: typeof content === "string" ? `[Workspace attachment loaded by tool]\n${content}` : [{ type: "text", text: "[Workspace attachment loaded by tool]" }, ...content] });
      }
    }
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
        data: checkpointData(checkpoint.model, messages, checkpoint.usage, checkpoint.deliveryDestination, checkpoint.reasoningEffort, checkpoint.maxContextTokens, checkpoint.visibleToolNames),
        updatedAt: progressedAt,
      },
    });
    const existingNextStep = claim.steps.find(step => step.sequence > operationStep.sequence && (step.state === "pending" || step.state === "running"));
    if (existingNextStep) {
      const advanced = { ...claim, run: { ...claim.run, revision: claim.run.revision + 1 }, checkpoint: { ...claim.checkpoint, version: claim.checkpoint.version + 1, data: checkpointData(checkpoint.model, messages, checkpoint.usage, checkpoint.deliveryDestination, checkpoint.reasoningEffort, checkpoint.maxContextTokens, checkpoint.visibleToolNames), updatedAt: progressedAt } };
      return existingNextStep.state === "pending"
        ? this.resumePendingCursor(advanced, { ...checkpoint, messages }, request, existingNextStep)
        : this.resumeOperationCursor(advanced, { ...checkpoint, messages }, request, existingNextStep);
    }
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
        data: checkpointData(checkpoint.model, messages, checkpoint.usage, checkpoint.deliveryDestination, checkpoint.reasoningEffort, checkpoint.maxContextTokens, checkpoint.visibleToolNames),
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
        data: checkpointData(checkpoint.model, messages, checkpoint.usage, checkpoint.deliveryDestination, checkpoint.reasoningEffort, checkpoint.maxContextTokens, checkpoint.visibleToolNames),
          updatedAt: this.now(),
        },
        steps: [...claim.steps, { ...nextStep, revision: 1, state: "running" }],
        operations: await this.store.listOperations(claim.run.id),
      }, checkpoint, request, { ...nextStep, revision: 1, state: "running" });
    }
    return this.execute({
      context: claim.run.context,
      model: checkpoint.model,
      ...(checkpoint.reasoningEffort ? { reasoningEffort: checkpoint.reasoningEffort } : {}),
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
      ...(checkpoint.maxContextTokens !== undefined ? { maxContextTokens: checkpoint.maxContextTokens } : {}),
      ...(checkpoint.visibleToolNames !== undefined ? { visibleToolNames: checkpoint.visibleToolNames } : {}),
    });
  }

  private projectOperationResult(result: OperationResult) {
    if (result.outcome === "succeeded") {
      return { status: "succeeded" as const, operationId: result.operationId, output: result.output ?? null, ...(result.artifactIds ? { artifactIds: result.artifactIds } : {}), ...(result.modelInputArtifactIds ? { modelInputArtifactIds: result.modelInputArtifactIds } : {}) };
    }
    return {
      status: result.outcome,
      operationId: result.operationId,
      error: result.error ?? { code: "operation_failed", message: "operation failed", retryable: false },
      ...(result.output !== undefined ? { output: result.output } : {}),
      ...(result.artifactIds ? { artifactIds: result.artifactIds } : {}),
      ...(result.modelInputArtifactIds ? { modelInputArtifactIds: result.modelInputArtifactIds } : {}),
    };
  }

  private isVisibleTool(name: string, visibleToolNames?: readonly string[]): boolean {
    return (name === "tool_catalog" && this.tools.get(name) !== undefined) || visibleToolNames === undefined || visibleToolNames.includes(name);
  }

  private hiddenToolResult(name: string) {
    return {
      status: "tool_not_found" as const,
      error: { code: "tool_not_found", message: `unknown tool: ${name}`, retryable: false },
    };
  }

  private invokeTool(call: ModelToolCall, runId: string, stepId: string, context: ExecutionContext, signal?: AbortSignal, visibleToolNames?: readonly string[]) {
    const routed = this.resolveCatalogCall(call, context);
    if (!routed && !this.isVisibleTool(call.name, visibleToolNames)) return Promise.resolve(this.hiddenToolResult(call.name));
    if (call.argumentError) {
      return Promise.resolve({
        status: "invalid_input" as const,
        error: { code: "malformed_tool_arguments", message: call.argumentError, retryable: false },
      });
    }
    if (routed?.error) return Promise.resolve({ status: "invalid_input" as const, error: { code: routed.error, message: routed.message!, retryable: false } });
    if (routed) call = { ...call, name: routed.toolName, input: routed.input };
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

  private resolveCatalogCall(call: ModelToolCall, context: ExecutionContext): { toolName: string; input: Record<string, unknown>; error?: string; message?: string } | undefined {
    if (call.name !== "tool_catalog" || call.input.action !== "call") return undefined;
    const catalogValidation = this.tools.validateInput("tool_catalog", call.input);
    if (!catalogValidation.valid) return { toolName: call.name, input: call.input, error: "invalid_catalog_input", message: catalogValidation.errors.join("; ") };
    const toolName = call.input.tool_name;
    const input = call.input.arguments;
    if (typeof toolName !== "string" || !toolName || toolName === "tool_catalog" || !input || typeof input !== "object" || Array.isArray(input)) {
      return { toolName: call.name, input: call.input, error: "invalid_catalog_call", message: "catalog call requires a non-catalog tool_name and object arguments" };
    }
    const catalog = this.tools.get("tool_catalog");
    if (!catalog) return { toolName: call.name, input: call.input, error: "tool_not_found", message: "tool catalog is unavailable" };
    const catalogDecision = authorize({ context, capability: catalog.policy.capability, tier: catalog.policy.tier, interactionRequirement: catalog.policy.interactionRequirement });
    if (!catalogDecision.allow) return { toolName: call.name, input: call.input, error: "permission_denied", message: catalogDecision.reason };
    const target = this.tools.get(toolName);
    if (!target) return { toolName: call.name, input: call.input, error: "tool_not_found", message: `unknown tool: ${toolName}` };
    return { toolName, input: input as Record<string, unknown> };
  }

  private async execute(request: HeadlessRunRequest, restored?: RestoredExecution): Promise<HeadlessRunResult> {
    validateRunLimits(request);
    const runId = restored?.runId ?? request.runId ?? this.createId("run");
    let runRevision = restored?.runRevision ?? 0;
    let sequence = restored?.sequence ?? 0;
    let checkpointVersion = restored?.checkpointVersion ?? 0;
    let usage = restored?.usage ?? ZERO_USAGE;
    const deliveryDestination = restored?.deliveryDestination ?? request.deliveryDestination ?? { kind: "caller" };
    const visibleToolNames = restored?.visibleToolNames ?? request.visibleToolNames;
    const toolDefinitions = this.tools.modelDefinitions(visibleToolNames);
    const maxContextTokens = restored?.maxContextTokens ?? request.maxContextTokens;
    const initialMessageBudget = messageBudget(maxContextTokens, toolDefinitions);
    const messages: ModelMessage[] = restored?.messages ?? buildInitialMessages({ ...request, ...(initialMessageBudget !== undefined ? { maxContextTokens: initialMessageBudget } : {}) });
    const compactWorkingMessages = (): void => {
      if (maxContextTokens === undefined) return;
      replaceMessages(messages, compactModelMessages(messages, toolDefinitions, maxContextTokens));
    };
    let executionContext = request.context;
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
        checkpoint: { runId, version: checkpointVersion + 1, data: checkpointData(request.model, messages, usage, deliveryDestination, request.reasoningEffort, maxContextTokens, visibleToolNames), updatedAt: this.now() },
      });
      runRevision += 1;
      checkpointVersion += 1;
      modelStep = { ...modelStep, revision: 1, state: "running" };
    }

    const maxModelTurns = request.maxModelTurns ?? DEFAULT_MAX_MODEL_TURNS;
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
    const appendPendingSteer = async (seal: boolean, completeCurrentStep: boolean) => {
      if (seal) await request.steerControl?.seal();
      else await request.steerControl?.flush();
      const pending = await this.store.listPendingSteeredInputs(runId);
      if (pending.length === 0) return 0;
      for (const input of pending) {
        messages.push({ role: "user", content: input.content });
        const roles = new Set(input.actorRoles);
        executionContext = {
          ...executionContext,
          actor: { ...executionContext.actor, roles: executionContext.actor.roles.filter(role => roles.has(role)) },
          authority: intersectAuthority(executionContext.authority, input.authority),
        };
      }
      const progressedAt = this.now();
      await this.store.updateExecutionProgress({
        runId,
        expectedRunRevision: runRevision,
        expectedRunState: "running",
        runState: "running",
        resumeEligibility: "eligible",
        runUpdatedAt: progressedAt,
        runContext: executionContext,
        step: { id: modelStep.id, expectedRevision: modelStep.revision, expectedState: "running", state: completeCurrentStep ? "succeeded" : "running", updatedAt: progressedAt },
        checkpoint: { runId, version: checkpointVersion + 1, data: checkpointData(request.model, messages, usage, deliveryDestination, request.reasoningEffort, maxContextTokens, visibleToolNames), updatedAt: progressedAt },
        consumedSteeredInputIds: pending.map(input => input.id),
      });
      runRevision += 1;
      checkpointVersion += 1;
      modelStep = { ...modelStep, revision: modelStep.revision + 1, state: completeCurrentStep ? "succeeded" : "running" };
      return pending.length;
    };
    const appendModelInputArtifacts = async (ids: readonly string[]): Promise<void> => {
      const unique = [...new Set(ids.filter(id => typeof id === "string" && id.length > 0))];
      if (unique.length === 0) return;
      if (!this.resolveModelInputArtifacts) throw new Error("model input artifacts cannot be resolved by this runtime");
      const content = await this.resolveModelInputArtifacts({ artifactIds: unique, context: executionContext, model: request.model });
      const parts = typeof content === "string"
        ? [{ type: "text" as const, text: `[Workspace attachment loaded by tool]\n${content}` }]
        : [{ type: "text" as const, text: "[Workspace attachment loaded by tool]" }, ...content];
      messages.push({ role: "user", content: parts });
      compactWorkingMessages();
    };
    try {
      for (let turn = 0; turn < maxModelTurns; turn += 1) {
        await appendPendingSteer(false, false);
        assertBudget(true);
        if (turn === maxModelTurns - 1) messages.push(finalModelTurnReminder(maxModelTurns));
        compactWorkingMessages();
        const response = await this.modelPort.generate({
          model: request.model,
          ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
          messages,
          tools: toolDefinitions,
          ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: Math.max(1, request.maxOutputTokens - usage.outputTokens) } : {}),
          ...(runSignal ? { signal: runSignal } : {}),
          ...(request.onTextDelta ? { onTextDelta: request.onTextDelta } : {}),
        });
        usage = addUsage(usage, response.usage);
        await this.store.recordModelCall({
          id: this.createId("model_call"), runId, stepId: modelStep.id, model: request.model,
          messages: projectModelMessagesForAudit(messages), response, createdAt: this.now(),
        });
        const steered = await appendPendingSteer(response.toolCalls.length === 0, true);
        if (steered > 0) {
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
            checkpoint: { runId, version: checkpointVersion + 1, data: checkpointData(request.model, messages, usage, deliveryDestination, request.reasoningEffort, maxContextTokens, visibleToolNames), updatedAt: this.now() },
          });
          runRevision += 1;
          checkpointVersion += 1;
          modelStep = { ...modelStep, revision: 1, state: "running" };
          continue;
        }
        messages.push(response.assistantMessage);
        await this.store.updateExecutionProgress({
          runId,
          expectedRunRevision: runRevision,
          expectedRunState: "running",
          runState: "running",
          resumeEligibility: "eligible",
          runUpdatedAt: this.now(),
          step: { id: modelStep.id, expectedRevision: 1, expectedState: "running", state: "succeeded", updatedAt: this.now() },
          checkpoint: { runId, version: checkpointVersion + 1, data: checkpointData(request.model, messages, usage, deliveryDestination, request.reasoningEffort, maxContextTokens, visibleToolNames), updatedAt: this.now() },
        });
        runRevision += 1;
        checkpointVersion += 1;
        assertBudget();

        if (response.toolCalls.length === 0) {
          const completedAt = this.now();
          const deliveryId = this.createId("delivery");
      const artifactIds = await this.artifactIdsForRun(runId);
      await this.store.completeRunWithOutput({
        output: { id: this.createId("output"), runId, text: response.text, usage, createdAt: completedAt, ...(artifactIds.length ? { artifactIds } : {}) },
            delivery: {
              id: deliveryId,
              runId,
              destination: deliveryDestination,
              payload: { text: response.text, ...(artifactIds.length ? { artifactIds } : {}) },
              state: "pending",
              createdAt: completedAt,
            },
            expectedRunRevision: runRevision,
            runUpdatedAt: completedAt,
          });
          return { status: "succeeded", runId, deliveryId, text: response.text, usage };
        }

        const modelInputArtifactIds: string[] = [];
        for (let callIndex = 0; callIndex < response.toolCalls.length;) {
          const first = response.toolCalls[callIndex]!;
          const parallel = this.tools.get(first.name)?.policy.concurrency === "parallel_safe";
          const batch = parallel
            ? response.toolCalls.slice(callIndex, callIndex + this.maxParallelToolCalls).filter((_call, offset, calls) =>
                calls.slice(0, offset + 1).every(candidate => this.tools.get(candidate.name)?.policy.concurrency === "parallel_safe"))
            : [first];
          callIndex += batch.length;
          toolCalls += batch.length;
          if (request.maxToolCalls !== undefined && toolCalls > request.maxToolCalls) throw new Error(`tool call budget exceeded: ${request.maxToolCalls}`);

          const prepared: Array<{ call: ModelToolCall; step: Step }> = [];
          for (const call of batch) {
            const step = this.newStep(runId, sequence++, "operation");
            prepared.push({ call, step });
            await this.store.appendStep(step);
            await this.store.updateExecutionProgress({
              runId,
              expectedRunRevision: runRevision,
              expectedRunState: "running",
              runState: "running",
              resumeEligibility: "eligible",
              runUpdatedAt: this.now(),
              step: { id: step.id, expectedRevision: 0, expectedState: "pending", state: "running", updatedAt: this.now() },
              checkpoint: { runId, version: checkpointVersion + 1, data: checkpointData(request.model, messages, usage, deliveryDestination, request.reasoningEffort, maxContextTokens, visibleToolNames), updatedAt: this.now() },
            });
            runRevision += 1;
            checkpointVersion += 1;
          }

          const completed = await Promise.all(prepared.map(async ({ call, step }) => ({
            call,
            step,
            result: call.argumentError
              ? { status: "invalid_input" as const, error: { code: "malformed_tool_arguments", message: call.argumentError, retryable: false } }
              : await this.invokeTool(call, runId, step.id, executionContext, runSignal, visibleToolNames),
          })));
          if (durationController?.signal.aborted) throw durationError;

          let outcomeUnknown = false;
          let cancellationError: string | undefined;
          for (const { call, step, result: toolResult } of completed) {
            const stepState = toolResult.status === "cancelled" ? "cancelled" : toolResult.status === "outcome_unknown" ? "failed" : "succeeded";
            const payload = toolResult.status === "succeeded"
              ? { ok: true, output: toolResult.output }
              : { ok: false, error: toolResult.error };
            if (toolResult.status !== "outcome_unknown" && toolResult.status !== "cancelled") {
              messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify(payload) });
              compactWorkingMessages();
            }
            if (toolResult.status === "outcome_unknown") outcomeUnknown = true;
            if (toolResult.status === "cancelled") cancellationError ??= toolResult.error.message;
            for (const id of toolResult.status === "succeeded" ? (toolResult.modelInputArtifactIds ?? []) : []) if (!modelInputArtifactIds.includes(id)) modelInputArtifactIds.push(id);
            await this.store.updateExecutionProgress({
              runId,
              expectedRunRevision: runRevision,
              expectedRunState: "running",
              runState: "running",
              resumeEligibility: "eligible",
              runUpdatedAt: this.now(),
              step: { id: step.id, expectedRevision: 1, expectedState: "running", state: stepState, updatedAt: this.now() },
              checkpoint: { runId, version: checkpointVersion + 1, data: checkpointData(request.model, messages, usage, deliveryDestination, request.reasoningEffort, maxContextTokens, visibleToolNames), updatedAt: this.now() },
            });
            runRevision += 1;
            checkpointVersion += 1;
          }
          if (outcomeUnknown) {
            await this.store.updateExecutionProgress({ runId, expectedRunRevision: runRevision, expectedRunState: "running", runState: "waiting", waitingReason: "operation_outcome_unknown", resumeEligibility: "manual_review", runUpdatedAt: this.now(), checkpoint: { runId, version: checkpointVersion + 1, data: checkpointData(request.model, messages, usage, deliveryDestination, request.reasoningEffort, maxContextTokens, visibleToolNames), updatedAt: this.now() } });
            return { status: "waiting", runId, reason: "outcome_unknown" };
          }
          if (cancellationError) {
            await this.store.updateExecutionProgress({ runId, expectedRunRevision: runRevision, expectedRunState: "running", runState: "cancelled", resumeEligibility: "ineligible", runUpdatedAt: this.now(), clearCheckpoint: true });
            return { status: "cancelled", runId, error: cancellationError };
          }
        }
        await appendModelInputArtifacts(modelInputArtifactIds);

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
          checkpoint: { runId, version: checkpointVersion + 1, data: checkpointData(request.model, messages, usage, deliveryDestination, request.reasoningEffort, maxContextTokens, visibleToolNames), updatedAt: this.now() },
        });
        runRevision += 1;
        checkpointVersion += 1;
        modelStep = { ...modelStep, revision: 1, state: "running" };
      }
      throw new Error(`model turn limit exceeded: ${maxModelTurns}`);
    } catch (caught) {
      // A stale worker must never overwrite progress committed by the winner.
      if (caught instanceof ExecutionStoreConflictError) throw caught;
      const message = caught instanceof Error ? caught.message : String(caught);
      const cancelled = request.signal?.aborted === true;
      const category: RunFailureCategory = caught instanceof ModelContextBudgetError
        ? "context_budget"
        : cancelled
          ? "run_cancelled"
          : message.includes("limit exceeded") || message.includes("budget exceeded")
            ? "limit"
            : (caught && typeof caught === "object" && ("status" in caught || "category" in caught || (caught instanceof Error && caught.name === "OpenAIRequestError")))
              ? "model_provider"
              : "processing";
      const failure: RunFailureMetadata = {
        category,
        errorName: caught instanceof Error ? caught.name : "NonErrorThrown",
        ...((caught && typeof caught === "object" && typeof (caught as { status?: unknown }).status === "number") ? { status: (caught as { status: number }).status } : {}),
        ...((caught && typeof caught === "object" && typeof (caught as { retryable?: unknown }).retryable === "boolean") ? { retryable: (caught as { retryable: boolean }).retryable } : {}),
      };
      await this.store.updateExecutionProgress({
        runId,
        expectedRunRevision: runRevision,
        expectedRunState: "running",
        runState: cancelled ? "cancelled" : "failed",
        resumeEligibility: "ineligible",
        runUpdatedAt: this.now(),
        clearCheckpoint: true,
        terminalDelivery: {
          id: this.createId("delivery"),
          runId,
          destination: deliveryDestination,
          payload: { text: cancelled ? "這次處理已取消。" : "這次處理失敗，請稍後再試。" },
          state: "pending",
          createdAt: this.now(),
        },
      });
      return { status: cancelled ? "cancelled" : "failed", runId, error: message, failure };
    } finally {
      if (durationTimer) clearTimeout(durationTimer);
    }
  }

  private newStep(runId: string, sequence: number, kind: Step["kind"]): Step {
    const now = this.now();
    return { id: this.createId("step"), runId, revision: 0, sequence, kind, state: "pending", createdAt: now, updatedAt: now };
  }
}
