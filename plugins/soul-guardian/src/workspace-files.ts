import { lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

const TARGET = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function missing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

export class SoulGuardianWorkspace {
  private root?: string;

  constructor(private readonly configuredRoot: string) {}

  async start(): Promise<void> {
    const configured = await lstat(this.configuredRoot);
    if (!configured.isDirectory() || configured.isSymbolicLink()) {
      throw new Error(`Soul Guardian workspace must be a non-symlink directory: ${this.configuredRoot}`);
    }
    this.root = await realpath(this.configuredRoot);
  }

  async read(target: string): Promise<Uint8Array | undefined> {
    const path = this.pathFor(target);
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`protected target is not a regular file: ${target}`);
      return await readFile(path);
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  }

  async writeAtomic(target: string, value: Uint8Array): Promise<void> {
    const path = this.pathFor(target);
    await this.ensureSafeParent(dirname(path));
    try {
      const current = await lstat(path);
      if (current.isSymbolicLink() || !current.isFile()) throw new Error(`protected target is unsafe: ${target}`);
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const temporary = `${path}.umiro-soul-guardian-${crypto.randomUUID()}`;
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

  private pathFor(target: string): string {
    if (!this.root) throw new Error("Soul Guardian workspace has not started");
    if (!TARGET.test(target) || target.split("/").some(part => part === "." || part === ".." || part === "")) {
      throw new TypeError(`invalid Soul Guardian target: ${target}`);
    }
    const path = resolve(this.root, target);
    if (!path.startsWith(`${this.root}${sep}`)) throw new Error(`Soul Guardian target escapes workspace: ${target}`);
    return path;
  }

  private async ensureSafeParent(parent: string): Promise<void> {
    if (!this.root) throw new Error("Soul Guardian workspace has not started");
    const path = relative(this.root, parent);
    let current = this.root;
    for (const part of path.split(sep).filter(Boolean)) {
      current = resolve(current, part);
      try {
        const stat = await lstat(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Soul Guardian parent is unsafe: ${current}`);
      } catch (error) {
        if (!missing(error)) throw error;
        await mkdir(current, { mode: 0o700 });
      }
    }
  }
}
