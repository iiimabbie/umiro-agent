import type { InstructionAuthority } from "../authorization/authority.js";
import type { Capability } from "../authorization/capability.js";
import type { ExecutionContext } from "../identity/execution-context.js";
import type { JsonObject } from "../ports/json.js";
import type { ConversationCompaction, ConversationHistoryItem, Turn } from "../conversation/entities.js";
import type { InputEvent } from "../input/event.js";

export type ContextRole = "soul" | "agent" | "memory" | (string & {});
export type ContextInfluence = "instruction" | "information";

export interface ContextSource {
  readonly kind: string;
  readonly ref: string;
  readonly metadata?: JsonObject;
}

export interface ContextBlock {
  readonly id: string;
  readonly providerId: string;
  readonly role: ContextRole;
  readonly content: string;
  readonly source: ContextSource;
  readonly influence: ContextInfluence;
  /** The authority level assigned to this block, never inherited from its text. */
  readonly instructionAuthority: InstructionAuthority;
  /** Essential blocks must fit; the engine fails rather than silently dropping identity or policy. */
  readonly retention?: "essential" | "normal";
  /** Context files are loaded for every model turn. Disclosure of private data is
   * an authorization concern and must not be encoded as context audience. */
  readonly parentSourceRef?: string;
}

export interface ContextRequest {
  readonly runId: string;
  readonly execution: ExecutionContext;
  readonly prompt: string;
  /** Present for interactive turns. Providers may use these trusted facts for
   * relevance only; they are not instruction or authorization sources. */
  readonly inputEvent?: InputEvent;
  readonly recentTurns?: readonly Turn[];
  readonly recentHistory?: readonly ConversationHistoryItem[];
  readonly conversationCompaction?: ConversationCompaction;
  readonly signal?: AbortSignal;
}

export interface ContextProvider {
  readonly id: string;
  readonly role: ContextRole;
  readonly priority: number;
  readonly requiredCapability?: Capability;
  load(request: ContextRequest): Promise<readonly ContextBlock[]>;
}

export interface ContextAssemblyRequest extends ContextRequest {
  /** Character ceiling for the first deterministic implementation. */
  readonly maxCharacters: number;
  /** Optional rendered-context token ceiling. A model-specific estimator may
   * be injected into ContextEngine; otherwise a conservative heuristic is used. */
  readonly maxTokens?: number;
}

export interface ContextAssembly {
  readonly blocks: readonly ContextBlock[];
  readonly omittedBlockIds: readonly string[];
  readonly characterCount: number;
  readonly estimatedTokenCount: number;
}
