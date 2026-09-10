export interface PluginStateEntry {
  readonly key: string;
  readonly size: number;
  readonly version?: number;
  readonly expiresAt?: string;
}

export interface PluginStateWriteOptions {
  readonly expiresAt?: string;
}

export interface VersionedPluginState {
  readonly value: Uint8Array;
  readonly version: number;
  readonly expiresAt?: string;
}

export interface PluginStateCompareAndSwapResult {
  readonly updated: boolean;
  readonly version?: number;
}

/** A namespace-scoped durable store. Implementations must reject traversal and symlinks.
 * Versioned operations are optional for simple stores; durable workflow plugins must
 * require them rather than emulating a claim with read followed by write. */
export interface PluginStateStore {
  read(key: string): Promise<Uint8Array | undefined>;
  writeAtomic(key: string, value: Uint8Array, options?: PluginStateWriteOptions): Promise<void>;
  remove(key: string): Promise<boolean>;
  list(prefix?: string): Promise<readonly PluginStateEntry[]>;
  readVersioned?(key: string): Promise<VersionedPluginState | undefined>;
  compareAndSwap?(key: string, expectedVersion: number, value: Uint8Array, options?: PluginStateWriteOptions): Promise<PluginStateCompareAndSwapResult>;
  deleteExpired?(now: string): Promise<number>;
}
