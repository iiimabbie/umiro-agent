import type { ContextProvider } from "./contract.js";

const PROVIDER_ID = /^[a-z][a-z0-9_.-]{0,127}$/;

export class ContextProviderRegistry {
  private readonly providers = new Map<string, ContextProvider>();

  register(provider: ContextProvider): void {
    if (!PROVIDER_ID.test(provider.id)) throw new TypeError(`invalid context provider id: ${provider.id}`);
    if (!provider.role.trim()) throw new TypeError(`context provider ${provider.id} requires a role`);
    if (!Number.isSafeInteger(provider.priority)) {
      throw new TypeError(`context provider ${provider.id} priority must be a safe integer`);
    }
    if (this.providers.has(provider.id)) throw new Error(`duplicate context provider registration: ${provider.id}`);
    this.providers.set(provider.id, provider);
  }

  unregister(providerId: string): boolean {
    return this.providers.delete(providerId);
  }

  get(providerId: string): ContextProvider | undefined {
    return this.providers.get(providerId);
  }

  list(): readonly ContextProvider[] {
    return [...this.providers.values()].sort(
      (left, right) => left.priority - right.priority || left.id.localeCompare(right.id),
    );
  }
}
