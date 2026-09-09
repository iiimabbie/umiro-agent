export interface PluginStateEntry {
  readonly key: string;
  readonly size: number;
}

/** A namespace-scoped durable store. Implementations must reject traversal and symlinks. */
export interface PluginStateStore {
  read(key: string): Promise<Uint8Array | undefined>;
  writeAtomic(key: string, value: Uint8Array): Promise<void>;
  remove(key: string): Promise<boolean>;
  list(prefix?: string): Promise<readonly PluginStateEntry[]>;
}
