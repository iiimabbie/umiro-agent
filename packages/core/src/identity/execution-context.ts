import type { Authority } from "../authorization/authority.js";
import type { Principal } from "./principal.js";

export type ExecutionOrigin =
  | { readonly kind: "interactive"; readonly transport: "discord"; readonly conversationId: string }
  | { readonly kind: "schedule"; readonly scheduleId: string }
  | { readonly kind: "delegation"; readonly parentRunId: string }
  | { readonly kind: "event"; readonly pluginId: string };

export interface ExecutionContext {
  readonly origin: ExecutionOrigin;
  readonly actor: Principal;
  readonly authority: Authority;
}
