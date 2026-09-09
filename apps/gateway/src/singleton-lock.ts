import { link, mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

interface LockRecord { readonly pid: number; readonly nonce: string; readonly startedAt: string }

function parseLockRecord(raw: string): LockRecord | undefined {
  try {
    const value = JSON.parse(raw) as Partial<LockRecord> | null;
    return value && Number.isSafeInteger(value.pid) && typeof value.nonce === "string" && value.nonce.length > 0 && typeof value.startedAt === "string"
      ? value as LockRecord
      : undefined;
  } catch { return undefined; }
}

export async function acquireSingletonLock(path: string, isAlive: (pid: number) => boolean = pid => { try { process.kill(pid, 0); return true; } catch { return false; } }): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 3; attempt++) {
    const nonce = crypto.randomUUID();
    const temporary = join(dirname(path), `.${nonce}.lock.tmp`);
    try {
      const handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, nonce, startedAt: new Date().toISOString() })}\n`);
      await handle.close();
      await link(temporary, path);
      await rm(temporary, { force: true });
      return async () => {
        const current = parseLockRecord(await readFile(path, "utf8").catch(() => ""));
        if (current?.nonce === nonce) await rm(path, { force: true });
      };
    } catch (error) {
      await rm(temporary, { force: true });
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const raw = await readFile(path, "utf8").catch(readError => {
        if ((readError as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw readError;
      });
      if (raw === undefined) continue;
      const current = parseLockRecord(raw);
      if (!current) throw new Error(`gateway singleton lock is invalid; refusing to remove it: ${path}`);
      if (current?.pid && isAlive(current.pid)) throw new Error(`another Umiro gateway is already running (pid ${current.pid})`);
      await rm(path, { force: true });
    }
  }
  throw new Error("could not acquire Umiro gateway singleton lock");
}
