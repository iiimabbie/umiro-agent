export class ConversationScopeBusyError extends Error {
  readonly code = "conversation_scope_busy";
  readonly statusCode = 409;
  constructor(readonly externalId: string) { super(`conversation scope ${externalId} has an active Run`); this.name = "ConversationScopeBusyError"; }
}

/** Serializes ingress and lifecycle mutations per transport scope. */
export class ConversationScopeLifecycleCoordinator {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly active = new Set<string>();

  isActive(externalId: string): boolean { return this.active.has(externalId); }

  async run<T>(externalId: string, operation: () => Promise<T>): Promise<T> {
    return this.withLock(externalId, async () => {
      this.active.add(externalId);
      try { return await operation(); } finally { this.active.delete(externalId); }
    });
  }

  async untrack<T>(externalId: string, operation: () => Promise<T>): Promise<T> {
    if (this.active.has(externalId)) throw new ConversationScopeBusyError(externalId);
    return this.withLock(externalId, async () => {
      if (this.active.has(externalId)) throw new ConversationScopeBusyError(externalId);
      return operation();
    });
  }

  private async withLock<T>(externalId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(externalId);
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    this.tails.set(externalId, current);
    if (previous) await previous;
    try { return await operation(); }
    finally {
      release();
      if (this.tails.get(externalId) === current) this.tails.delete(externalId);
    }
  }
}
