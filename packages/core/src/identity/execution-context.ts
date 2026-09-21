import type { Authority } from "../authorization/authority.js";
import type { Principal } from "./principal.js";
import type { ModelCapability, ReasoningEffort } from "../model/contract.js";

export type ExecutionOrigin =
  | { readonly kind: "interactive"; readonly transport: string; readonly conversationId: string }
  | { readonly kind: "schedule"; readonly scheduleId: string }
  | { readonly kind: "delegation"; readonly parentRunId: string }
  | { readonly kind: "event"; readonly pluginId: string };

export interface ExecutionContext {
  readonly origin: ExecutionOrigin;
  readonly actor: Principal;
  readonly authority: Authority;
  /** Request-scoped model selection; never contains provider credentials. */
  readonly modelProfile?: {
    readonly id: string;
    readonly model: string;
    /** Provider protocol fixed when this Run was created. */
    readonly protocol: string;
    readonly capabilities: readonly ModelCapability[];
    readonly reasoningEffort?: ReasoningEffort;
  };
}
