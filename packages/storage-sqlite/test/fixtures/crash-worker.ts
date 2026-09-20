import { writeFileSync } from "node:fs";
import {
  authorize,
  capabilities,
  type AuthorizationDecisionRecord,
  type ExecutionContext,
  type Operation,
  type Run,
  type Step,
} from "@umiro/core";
import { SQLiteExecutionStore } from "../../src/index.js";

const [filename, boundary, marker] = process.argv.slice(2);
if (!filename || !boundary) throw new Error("filename and boundary are required");
const at = "2026-09-09T02:00:00.000Z";
const context: ExecutionContext = {
  actor: { id: "owner", kind: "human", roles: ["owner"] },
  origin: { kind: "event", pluginId: "crash-worker" },
  authority: {
    capabilities: capabilities("test.crash"),
    visibility: { kind: "all" },
    instructionAuthority: "full",
  },
};
const store = new SQLiteExecutionStore(filename);
const run: Run = {
  id: "run-crash", revision: 0, state: "queued", context, resumeEligibility: "eligible", createdAt: at, updatedAt: at,
};
const modelBoundary = boundary.startsWith("model_");
const step: Step = {
  id: "step-crash",
  runId: run.id,
  revision: 0,
  sequence: 0,
  kind: modelBoundary ? "model_call" : "operation",
  state: "pending",
  createdAt: at,
  updatedAt: at,
};
await store.createRunWithStep(run, step);
const toolCall = { id: "call-crash", name: "test.crash", input: {} };
await store.updateExecutionProgress({
  runId: run.id,
  expectedRunRevision: 0,
  expectedRunState: "queued",
  runState: "running",
  resumeEligibility: "eligible",
  runUpdatedAt: at,
  step: { id: step.id, expectedRevision: 0, expectedState: "pending", state: "running", updatedAt: at },
  checkpoint: {
    runId: run.id,
    version: 1,
    data: {
      version: 2,
      model: "fake-model",
      messages: modelBoundary
        ? [{ role: "user", content: "crash" }]
        : [{ role: "user", content: "crash" }, { role: "assistant", content: null, toolCalls: [toolCall] }],
      usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
      deliveryDestination: { kind: "test" },
    },
    updatedAt: at,
  },
});

if (boundary === "model_recorded") {
  await store.recordModelCall({
    id: "model-call-crash",
    runId: run.id,
    stepId: step.id,
    model: "fake-model",
    messages: [{ role: "user", content: "crash" }],
    response: {
      text: "durable",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 },
      assistantMessage: { role: "assistant", content: "durable" },
    },
    createdAt: at,
  });
}

if (!modelBoundary) {
  const base = authorize({ context, capability: "test.crash", tier: "common" });
  const decision: AuthorizationDecisionRecord = {
    ...base,
    id: "authorization-crash",
    operationId: "operation-crash",
    decidedAt: at,
  };
  const sideEffect = boundary === "tool_effect_applied" ? "non_idempotent" : "idempotent";
  const operation: Operation = {
    id: "operation-crash",
    stepId: step.id,
    kind: "tool:test.crash",
    input: {},
    state: "authorized",
    capability: "test.crash",
    authorizationTier: "common",
    sideEffect,
    ...(sideEffect === "idempotent" ? { idempotencyKey: `${run.id}:${toolCall.id}` } : {}),
    authorizationDecisionId: decision.id,
    createdAt: at,
    updatedAt: at,
  };
  await store.recordOperationAuthorization(operation, decision);
  if (boundary !== "tool_authorized") await store.markOperationExecuting(operation.id, at);
  if (boundary === "tool_effect_applied" && marker) writeFileSync(marker, "effect-applied\n", "utf8");
  if (boundary === "tool_result_recorded") {
    await store.recordOperationOutcome(operation.id, {
      operationId: operation.id,
      outcome: "succeeded",
      effectStatus: "confirmed",
      output: { durable: true },
      completedAt: at,
    }, at);
  }
}

process.stdout.write("READY\n");
await new Promise(() => undefined);
