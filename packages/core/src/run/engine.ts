import type { ModelMessage, ModelPort, ModelUsage } from "../model/contract.js";
import { ExecutionStoreConflictError, type ExecutionStore } from "../ports/execution-store.js";
import type { JsonValue } from "../ports/json.js";
import { ToolRegistry, ToolRuntime } from "../tool/index.js";
import type { ExecutionContext } from "../identity/execution-context.js";
import type { Run, Step } from "./entities.js";

export interface HeadlessRunRequest {
  readonly context: ExecutionContext;
  readonly model: string;
  readonly prompt: string;
  readonly signal?: AbortSignal;
  readonly maxModelTurns?: number;
}

export type HeadlessRunResult =
  | { readonly status: "succeeded"; readonly runId: string; readonly text: string; readonly usage: ModelUsage }
  | { readonly status: "waiting"; readonly runId: string; readonly reason: "outcome_unknown" }
  | { readonly status: "failed" | "cancelled"; readonly runId: string; readonly error: string };

export interface HeadlessRunEngineOptions {
  readonly now?: () => string;
  readonly createId?: (kind: "run" | "step" | "model_call" | "output" | "operation" | "authorization") => string;
}

const ZERO_USAGE: ModelUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };

function addUsage(left: ModelUsage, right: ModelUsage): ModelUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
  };
}

function checkpointData(messages: readonly ModelMessage[]): JsonValue {
  return JSON.parse(JSON.stringify({ messages })) as JsonValue;
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
    const runId = this.createId("run");
    const startedAt = this.now();
    let runRevision = 0;
    let sequence = 0;
    let checkpointVersion = 0;
    let usage = ZERO_USAGE;
    const messages: ModelMessage[] = [{ role: "user", content: request.prompt }];
    let modelStep = this.newStep(runId, sequence++, "model_call");
    const run: Run = {
      id: runId,
      revision: 0,
      state: "queued",
      context: request.context,
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
      checkpoint: { runId, version: checkpointVersion + 1, data: checkpointData(messages), updatedAt: this.now() },
    });
    runRevision += 1;
    checkpointVersion += 1;

    const maxModelTurns = request.maxModelTurns ?? 8;
    try {
      for (let turn = 0; turn < maxModelTurns; turn += 1) {
        const response = await this.modelPort.generate({
          model: request.model,
          messages,
          tools: this.tools.modelDefinitions(),
          ...(request.signal ? { signal: request.signal } : {}),
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
          checkpoint: { runId, version: checkpointVersion + 1, data: checkpointData(messages), updatedAt: this.now() },
        });
        runRevision += 1;
        checkpointVersion += 1;

        if (response.toolCalls.length === 0) {
          const completedAt = this.now();
          await this.store.completeRunWithOutput({
            output: { id: this.createId("output"), runId, text: response.text, usage, createdAt: completedAt },
            expectedRunRevision: runRevision,
            runUpdatedAt: completedAt,
          });
          return { status: "succeeded", runId, text: response.text, usage };
        }

        for (const call of response.toolCalls) {
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
            checkpoint: { runId, version: checkpointVersion + 1, data: checkpointData(messages), updatedAt: this.now() },
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
                ...(request.signal ? { signal: request.signal } : {}),
              });
          const stepState = toolResult.status === "cancelled" ? "cancelled" : toolResult.status === "outcome_unknown" ? "failed" : "succeeded";
          await this.store.updateExecutionProgress({
            runId,
            expectedRunRevision: runRevision,
            expectedRunState: "running",
            runState: toolResult.status === "outcome_unknown" ? "waiting" : toolResult.status === "cancelled" ? "cancelled" : "running",
            resumeEligibility: toolResult.status === "outcome_unknown" ? "manual_review" : toolResult.status === "cancelled" ? "ineligible" : "eligible",
            ...(toolResult.status === "outcome_unknown" ? { waitingReason: "operation_outcome_unknown" } : {}),
            runUpdatedAt: this.now(),
            step: { id: toolStep.id, expectedRevision: 1, expectedState: "running", state: stepState, updatedAt: this.now() },
            checkpoint: { runId, version: checkpointVersion + 1, data: checkpointData(messages), updatedAt: this.now() },
          });
          runRevision += 1;
          checkpointVersion += 1;
          if (toolResult.status === "outcome_unknown") return { status: "waiting", runId, reason: "outcome_unknown" };
          if (toolResult.status === "cancelled") return { status: "cancelled", runId, error: toolResult.error.message };
          const payload = toolResult.status === "succeeded"
            ? { ok: true, output: toolResult.output }
            : { ok: false, error: toolResult.error };
          messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify(payload) });
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
          checkpoint: { runId, version: checkpointVersion + 1, data: checkpointData(messages), updatedAt: this.now() },
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
    }
  }

  private newStep(runId: string, sequence: number, kind: Step["kind"]): Step {
    const now = this.now();
    return { id: this.createId("step"), runId, revision: 0, sequence, kind, state: "pending", createdAt: now, updatedAt: now };
  }
}
