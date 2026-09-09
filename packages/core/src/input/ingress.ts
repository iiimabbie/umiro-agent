import type { Authority } from "../authorization/authority.js";
import type { ContextEngine } from "../context/engine.js";
import type { ConversationIngressStore } from "../conversation/store.js";
import type { IdentityResolver } from "../identity/principal.js";
import type { JsonObject } from "../ports/json.js";
import { HeadlessRunEngine, type HeadlessRunResult } from "../run/engine.js";
import type { ExecutionStore } from "../ports/execution-store.js";
import { inputText, type InputEvent } from "./event.js";

export interface InteractiveIngressRequest {
  readonly event: InputEvent;
  readonly model: string;
  readonly maxContextCharacters: number;
  readonly deliveryDestination: JsonObject;
  readonly signal?: AbortSignal;
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
    const prompt = inputText(request.event).trim();
    if (!prompt) throw new TypeError("Input Event does not contain text");
    const resolved = await this.identities.resolve(request.event.identity);
    const runId = this.createId("run");
    const ingested = await this.conversations.ingestInputEvent({
      event: request.event,
      actorPrincipalId: resolved.principal.id,
      newConversationId: this.createId("conversation"),
      newTurnId: this.createId("turn"),
      newRunId: runId,
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
    };
    const assembledContext = await this.contexts.assemble({
      runId: primaryRunId,
      execution,
      prompt,
      maxCharacters: request.maxContextCharacters,
      ...(request.signal ? { signal: request.signal } : {}),
    });
    const result = await this.engine.run({
      runId: primaryRunId,
      context: execution,
      conversationId: ingested.conversation.id,
      turnId: ingested.turn.id,
      model: request.model,
      prompt,
      assembledContext,
      deliveryDestination: request.deliveryDestination,
      ...(request.signal ? { signal: request.signal } : {}),
    });
    return {
      status: "executed",
      conversationId: ingested.conversation.id,
      turnId: ingested.turn.id,
      result,
    };
  }
}
