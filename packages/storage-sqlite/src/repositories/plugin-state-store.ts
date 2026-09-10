import type Database from "better-sqlite3";
import type { PluginStateCompareAndSwapResult, PluginStateEntry, PluginStateStore, PluginStateWriteOptions, VersionedPluginState } from "@umiro/core/plugin";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

interface StateRow {
  value: Buffer;
  version: number;
  expires_at: string | null;
}

function validateNamespace(namespace: string): void {
  if (!NAME.test(namespace)) throw new TypeError(`invalid plugin state namespace: ${namespace}`);
}

function validateKey(key: string): void {
  if (!KEY.test(key) || key.split("/").some(part => part === "." || part === ".." || part === "")) {
    throw new TypeError(`invalid plugin state key: ${key}`);
  }
}

function validateExpiry(expiresAt: string | undefined): void {
  if (expiresAt !== undefined && !Number.isFinite(Date.parse(expiresAt))) throw new TypeError("invalid plugin state expiry");
}

export class SQLitePluginStateStore implements PluginStateStore {
  constructor(private readonly database: Database.Database, private readonly namespace: string, private readonly now = () => new Date().toISOString()) {
    validateNamespace(namespace);
  }

  async read(key: string): Promise<Uint8Array | undefined> {
    return (await this.readVersioned(key))?.value;
  }

  async readVersioned(key: string): Promise<VersionedPluginState | undefined> {
    validateKey(key);
    return this.database.transaction(() => {
      const now = this.now();
      this.database.prepare("DELETE FROM plugin_state WHERE namespace=? AND key=? AND expires_at IS NOT NULL AND expires_at<=?").run(this.namespace, key, now);
      const row = this.database.prepare("SELECT value, version, expires_at FROM plugin_state WHERE namespace=? AND key=?").get(this.namespace, key) as StateRow | undefined;
      return row ? { value: new Uint8Array(row.value), version: row.version, ...(row.expires_at ? { expiresAt: row.expires_at } : {}) } : undefined;
    })();
  }

  async writeAtomic(key: string, value: Uint8Array, options: PluginStateWriteOptions = {}): Promise<void> {
    validateKey(key);
    validateExpiry(options.expiresAt);
    const at = this.now();
    this.database.prepare(`INSERT INTO plugin_state(namespace,key,value,version,created_at,updated_at,expires_at)
      VALUES (?,?,?,1,?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value, version=plugin_state.version+1, updated_at=excluded.updated_at, expires_at=excluded.expires_at`)
      .run(this.namespace, key, Buffer.from(value), at, at, options.expiresAt ?? null);
  }

  async compareAndSwap(key: string, expectedVersion: number, value: Uint8Array, options: PluginStateWriteOptions = {}): Promise<PluginStateCompareAndSwapResult> {
    validateKey(key);
    validateExpiry(options.expiresAt);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new TypeError("expected plugin state version must be a positive integer");
    const result = this.database.prepare(`UPDATE plugin_state SET value=?, version=version+1, updated_at=?, expires_at=?
      WHERE namespace=? AND key=? AND version=? AND (expires_at IS NULL OR expires_at>?)`)
      .run(Buffer.from(value), this.now(), options.expiresAt ?? null, this.namespace, key, expectedVersion, this.now());
    return result.changes === 1 ? { updated: true, version: expectedVersion + 1 } : { updated: false };
  }

  async remove(key: string): Promise<boolean> {
    validateKey(key);
    return this.database.prepare("DELETE FROM plugin_state WHERE namespace=? AND key=?").run(this.namespace, key).changes === 1;
  }

  async list(prefix = ""): Promise<readonly PluginStateEntry[]> {
    if (prefix) validateKey(prefix);
    await this.deleteExpired(this.now());
    const rows = this.database.prepare("SELECT key, length(value) AS size, version, expires_at FROM plugin_state WHERE namespace=? AND key LIKE ? ESCAPE '\\' ORDER BY key")
      .all(this.namespace, `${prefix.replace(/[\\%_]/g, value => `\\${value}`)}%`) as Array<{ key: string; size: number; version: number; expires_at: string | null }>;
    return rows.map(row => ({ key: row.key, size: row.size, version: row.version, ...(row.expires_at ? { expiresAt: row.expires_at } : {}) }));
  }

  async deleteExpired(now: string): Promise<number> {
    if (!Number.isFinite(Date.parse(now))) throw new TypeError("invalid plugin state cleanup time");
    return this.database.prepare("DELETE FROM plugin_state WHERE namespace=? AND expires_at IS NOT NULL AND expires_at<=?").run(this.namespace, now).changes;
  }
}
