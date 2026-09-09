import { mkdir, lstat, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { PluginStateEntry, PluginStateStore } from "@umiro/core/plugin";

const KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function missing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

export class FilePluginStateStore implements PluginStateStore {
  private root?: string;

  constructor(private readonly configuredRoot: string) {}

  async read(key: string): Promise<Uint8Array | undefined> {
    const path = await this.pathFor(key);
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`plugin state entry is not a regular file: ${key}`);
      return await readFile(path);
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  }

  async writeAtomic(key: string, value: Uint8Array): Promise<void> {
    const path = await this.pathFor(key);
    await this.ensureSafeDirectory(dirname(path));
    const temporary = `${path}.tmp-${crypto.randomUUID()}`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(value);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, path);
      const directory = await open(dirname(path), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async remove(key: string): Promise<boolean> {
    const path = await this.pathFor(key);
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`plugin state entry is not a regular file: ${key}`);
      await rm(path);
      return true;
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
  }

  async list(prefix = ""): Promise<readonly PluginStateEntry[]> {
    if (prefix) this.validateKey(prefix);
    const root = await this.ensureRoot();
    const entries: PluginStateEntry[] = [];
    await this.walk(root, entries);
    return entries.filter(entry => entry.key.startsWith(prefix)).sort((a, b) => a.key.localeCompare(b.key));
  }

  private async walk(directory: string, output: PluginStateEntry[]): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`plugin state contains a symlink: ${path}`);
      if (entry.isDirectory()) {
        await this.walk(path, output);
      } else if (entry.isFile()) {
        const stat = await lstat(path);
        output.push({ key: relative(await this.ensureRoot(), path).split(sep).join("/"), size: stat.size });
      }
    }
  }

  private async pathFor(key: string): Promise<string> {
    this.validateKey(key);
    const root = await this.ensureRoot();
    const path = resolve(root, key);
    if (!path.startsWith(`${root}${sep}`)) throw new Error(`plugin state key escapes its namespace: ${key}`);
    return path;
  }

  private validateKey(key: string): void {
    if (!KEY.test(key) || key.split("/").some(part => part === "." || part === ".." || part === "")) {
      throw new TypeError(`invalid plugin state key: ${key}`);
    }
  }

  private async ensureRoot(): Promise<string> {
    if (this.root) return this.root;
    await mkdir(this.configuredRoot, { recursive: true, mode: 0o700 });
    const configured = await lstat(this.configuredRoot);
    if (!configured.isDirectory() || configured.isSymbolicLink()) {
      throw new Error(`plugin state root must be a regular directory: ${this.configuredRoot}`);
    }
    this.root = await realpath(this.configuredRoot);
    return this.root;
  }

  private async ensureSafeDirectory(directory: string): Promise<void> {
    const root = await this.ensureRoot();
    const path = relative(root, directory);
    let current = root;
    for (const part of path.split(sep).filter(Boolean)) {
      current = join(current, part);
      try {
        const stat = await lstat(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`plugin state directory is unsafe: ${current}`);
      } catch (error) {
        if (!missing(error)) throw error;
        await mkdir(current, { mode: 0o700 });
      }
    }
  }
}
