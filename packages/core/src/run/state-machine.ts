import type { RunState, StepState } from "./entities.js";

const RUN_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  queued: ["running", "cancelled"],
  running: ["waiting", "succeeded", "failed", "cancelled", "timed_out"],
  waiting: ["running", "failed", "cancelled", "timed_out"],
  succeeded: [],
  failed: [],
  cancelled: [],
  timed_out: [],
};

const STEP_TRANSITIONS: Readonly<Record<StepState, readonly StepState[]>> = {
  pending: ["running", "cancelled"],
  running: ["succeeded", "failed", "cancelled", "timed_out"],
  succeeded: [],
  failed: [],
  cancelled: [],
  timed_out: [],
};

export class InvalidStateTransitionError extends Error {
  constructor(readonly entity: "run" | "step", readonly from: string, readonly to: string) {
    super(`invalid ${entity} transition: ${from} -> ${to}`);
    this.name = "InvalidStateTransitionError";
  }
}

export function canTransitionRun(from: RunState, to: RunState): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

export function assertRunTransition(from: RunState, to: RunState): void {
  if (!canTransitionRun(from, to)) throw new InvalidStateTransitionError("run", from, to);
}

export function isTerminalRunState(state: RunState): boolean {
  return RUN_TRANSITIONS[state].length === 0;
}

export function canTransitionStep(from: StepState, to: StepState): boolean {
  return STEP_TRANSITIONS[from].includes(to);
}

export function assertStepTransition(from: StepState, to: StepState): void {
  if (!canTransitionStep(from, to)) throw new InvalidStateTransitionError("step", from, to);
}
