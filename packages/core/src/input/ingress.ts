import type { Authority } from "../authorization/authority.js";
import type { ContextEngine } from "../context/engine.js";
import type { ConversationIngressStore, ConversationSeedTurn, IngestInputEventResult } from "../conversation/store.js";
import type { IdentityResolver } from "../identity/principal.js";
import type { JsonObject } from "../ports/json.js";
import { HeadlessRunEngine, type HeadlessRunResult } from "../run/engine.js";
import type { ExecutionStore } from "../ports/execution-store.js";
import { inputText, type InputEvent } from "./event.js";
import type { ModelCapability, ModelContent, ReasoningEffort } from "../model/contract.js";
import { conversationHistoryToMessages } from "../conversation/history.js";
import { recentToolEvidenceBlock } from "../conversation/tool-evidence.js";
import { partitionContextTokenBudget } from "./budget.js";
import type { ContextBlock } from "../context/contract.js";

export interface InteractiveIngressRequest {
  readonly event: InputEvent;
  readonly model: string;
  /** Immutable model selection snapshot for this interactive Run. */
  readonly modelProfile?: { readonly id: string; readonly model: string; readonly protocol: string; readonly capabilities: readonly ModelCapability[]; readonly reasoningEffort?: ReasoningEffort };
  readonly reasoningEffort?: ReasoningEffort;
  readonly userContent?: ModelContent;
  readonly maxContextCharacters: number;
  readonly maxContextTokens?: number;
  readonly maxToolCalls?: number;
  readonly maxDurationMs?: number;
  readonly deliveryDestination: JsonObject;
  readonly signal?: AbortSignal;
  readonly onTextDelta?: (delta: string) => void | Promise<void>;
  readonly onRunCreated?: (runId: string) => void;
  readonly onContextOmission?: (details: { readonly omittedHistoryMessages: number; readonly retainedHistoryMessages: number; readonly truncatedHistoryMessages: number }) => void;
  readonly steerControl?: { readonly flush: () => Promise<void>; readonly seal: () => Promise<void> };
  readonly initialTurns?: readonly ConversationSeedTurn[];
  readonly precomputedBlocks?: readonly ContextBlock[];
  readonly visibleToolNames?: readonly string[];
}

export type InteractiveIngressResult =
  | {
      readonly status: "duplicate";
      readonly conversationId: string;
      readonly turnId: string;
      readonly runId: string;
      readonly runState?: string;
    }
  | {
      readonly status: "executed";
      readonly conversationId: string;
      readonly turnId: string;
      readonly result: HeadlessRunResult;
    };

export interface InteractiveIngressOptions {
  readonly now?: () => string;
  readonly createId?: (kind: "conversation" | "turn" | "run") => string;
}

export class InteractiveIngress {
  private readonly now: () => string;
  private readonly createId: NonNullable<InteractiveIngressOptions["createId"]>;

  constructor(
    private readonly identities: IdentityResolver,
    private readonly conversations: ConversationIngressStore,
    private readonly executions: ExecutionStore,
    private readonly contexts: ContextEngine,
    private readonly engine: HeadlessRunEngine,
    options: InteractiveIngressOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? (() => crypto.randomUUID());
  }

  async handle(request: InteractiveIngressRequest): Promise<InteractiveIngressResult> {
    const text = inputText(request.event).trim();
    const prompt = text || (request.event.content.some(block => block.type === "artifact_reference") ? "Please inspect the attached file(s) and respond." : "");
    if (!prompt) throw new TypeError("Input Event does not contain text or attachments");
    const resolved = await this.identities.resolve(request.event.identity);
    const runId = this.createId("run");
    request.onRunCreated?.(runId);
    const ingested = await this.conversations.ingestInputEvent({
      event: request.event,
      actorPrincipalId: resolved.principal.id,
      newConversationId: this.createId("conversation"),
      newTurnId: this.createId("turn"),
      newRunId: runId,
      ...(request.initialTurns?.length ? { initialTurns: request.initialTurns } : {}),
      createdAt: this.now(),
    });
    const primaryRunId = ingested.turn.primaryRunId ?? runId;
    if (ingested.duplicate) {
      const existing = await this.executions.getRun(primaryRunId);
      if (existing) {
        return {
          status: "duplicate",
          conversationId: ingested.conversation.id,
          turnId: ingested.turn.id,
          runId: existing.id,
          runState: existing.state,
        };
      }
    }

    const authority: Authority = resolved.authority;
    const execution = {
      origin: {
        kind: "interactive" as const,
        transport: request.event.identity.transport,
        conversationId: ingested.conversation.id,
      },
      actor: resolved.principal,
      authority,
      ...(request.modelProfile ? { modelProfile: request.modelProfile } : {}),
    };
    const historyLimit = 24;
    const conversationCompaction = await this.conversations.refreshConversationCompaction({
      conversationId: ingested.conversation.id,
      beforeSequence: ingested.turn.sequence,
      retainRecent: historyLimit,
      maxCharacters: Math.min(12_000, Math.max(2_000, Math.floor(request.maxContextCharacters / 3))),
      updatedAt: this.now(),
    });
    const replyTarget = ingested.turn.replyToTurnId
      ? await this.conversations.getHistoryItem(ingested.turn.replyToTurnId)
      : undefined;
    const recentHistory = await this.conversations.listRecentHistory(ingested.conversation.id, ingested.turn.sequence, historyLimit);
    const history = conversationHistoryToMessages(recentHistory);
    const toolEvidenceBlock = recentToolEvidenceBlock(recentHistory, ingested.conversation.id, authority.visibility);
    const currentMessage = { role: "user" as const, content: request.userContent ?? prompt };
    const contextBudget = request.maxContextTokens === undefined ? undefined : partitionContextTokenBudget(request.maxContextTokens, history, currentMessage);
    const assembledContext = await this.contexts.assemble({
      runId: primaryRunId,
      execution,
      prompt,
      inputEvent: request.event,
      recentTurns: await this.conversations.listTurns(ingested.conversation.id, 12),
      recentHistory,
      ...(replyTarget ? { replyTarget } : {}),
      ...(conversationCompaction ? { conversationCompaction } : {}),
      ...(request.precomputedBlocks || toolEvidenceBlock
        ? { precomputedBlocks: [...(request.precomputedBlocks ?? []), ...(toolEvidenceBlock ? [toolEvidenceBlock] : [])] }
        : {}),
      maxCharacters: request.maxContextCharacters,
      ...(contextBudget ? { maxTokens: contextBudget.contextMaxTokens } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.onTextDelta ? { onTextDelta: request.onTextDelta } : {}),
    });
    const result = await this.engine.run({
      runId: primaryRunId,
      context: execution,
      conversationId: ingested.conversation.id,
      turnId: ingested.turn.id,
      model: request.model,
      ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
      prompt,
      ...(request.userContent ? { userContent: request.userContent } : {}),
      history,
      ...(request.maxContextTokens !== undefined ? { maxContextTokens: request.maxContextTokens } : {}),
      ...(request.maxToolCalls !== undefined ? { maxToolCalls: request.maxToolCalls } : {}),
      ...(request.maxDurationMs !== undefined ? { maxDurationMs: request.maxDurationMs } : {}),
      ...(request.onContextOmission ? { onContextOmission: request.onContextOmission } : {}),
      assembledContext,
      ...(request.visibleToolNames !== undefined ? { visibleToolNames: request.visibleToolNames } : {}),
      deliveryDestination: request.deliveryDestination,
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.onTextDelta ? { onTextDelta: request.onTextDelta } : {}),
      ...(request.steerControl ? { steerControl: request.steerControl } : {}),
    });
    return {
      status: "executed",
      conversationId: ingested.conversation.id,
      turnId: ingested.turn.id,
      result,
    };
  }

  async hasActiveConversation(event: InputEvent): Promise<boolean> {
    return this.conversations.hasActiveConversationScope(event.conversation.transport, event.conversation.externalId);
  }

  async steer(request: { readonly event: InputEvent; readonly runId: string; readonly userContent: ModelContent }): Promise<{ readonly conversationId: string; readonly turnId: string; readonly duplicate: boolean }> {
    const resolved = await this.identities.resolve(request.event.identity);
    const result = await this.conversations.steerInputEvent({ event: request.event, actorPrincipalId: resolved.principal.id, actorRoles: resolved.principal.roles, authority: resolved.authority, runId: request.runId, newTurnId: this.createId("turn"), modelContent: request.userContent, createdAt: this.now() });
    return { conversationId: result.conversation.id, turnId: result.turn.id, duplicate: result.duplicate };
  }

  async observe(event: InputEvent, establishScope = false, initialTurns?: readonly ConversationSeedTurn[]): Promise<IngestInputEventResult | undefined> {
    const prompt = inputText(event).trim();
    if (!prompt) return undefined;
    const resolved = await this.identities.resolve(event.identity);
    return this.conversations.observeInputEvent({
      event,
      actorPrincipalId: resolved.principal.id,
      newConversationId: this.createId("conversation"),
      newTurnId: this.createId("turn"),
      ...(initialTurns?.length ? { initialTurns } : {}),
      createdAt: this.now(),
      ...(establishScope ? { establishScope: true } : {}),
    });
  }
}
