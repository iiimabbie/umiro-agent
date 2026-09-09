import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";

interface LockRecord { readonly pid: number; readonly nonce: string; readonly startedAt: string }

export async function acquireSingletonLock(path: string, isAlive: (pid: number) => boolean = pid => { try { process.kill(pid, 0); return true; } catch { return false; } }): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    const nonce = crypto.randomUUID();
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, nonce, startedAt: new Date().toISOString() })}\n`);
      await handle.close();
      return async () => {
        const current = JSON.parse(await readFile(path, "utf8").catch(() => "null")) as LockRecord | null;
        if (current?.nonce === nonce) await rm(path, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const current = JSON.parse(await readFile(path, "utf8").catch(() => "null")) as LockRecord | null;
      if (current?.pid && isAlive(current.pid)) throw new Error(`another Umiro gateway is already running (pid ${current.pid})`);
      await rm(path, { force: true });
    }
  }
  throw new Error("could not acquire Umiro gateway singleton lock");
}
