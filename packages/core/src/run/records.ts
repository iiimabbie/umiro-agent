import type { ModelMessage, ModelResponse, ModelUsage } from "../model/contract.js";
import type { StepId, RunId } from "./entities.js";

export interface ModelCallRecord {
  readonly id: string;
  readonly runId: RunId;
  readonly stepId: StepId;
  readonly model: string;
  readonly messages: readonly ModelMessage[];
  readonly response: ModelResponse;
  readonly createdAt: string;
}

export interface RunOutput {
  readonly id: string;
  readonly runId: RunId;
  readonly text: string;
  readonly usage: ModelUsage;
  readonly createdAt: string;
}
