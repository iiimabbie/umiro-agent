import { rename, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface PendingRestart {
  readonly applicationId: string;
  readonly token: string;
  readonly createdAt: number;
}

const RESTART_TOKEN_TTL_MS = 14 * 60 * 1_000;

export async function savePendingRestart(path: string, interaction: { readonly applicationId: string; readonly token: string }, now = Date.now()): Promise<void> {
  if (!interaction.applicationId.trim() || !interaction.token.trim()) throw new TypeError("restart interaction credentials are required");
  const temporary = join(dirname(path), `.${basename(path)}-${crypto.randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify({ ...interaction, createdAt: now } satisfies PendingRestart)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function completePendingRestart(path: string, botName: string, options: { readonly now?: number; readonly fetch?: typeof fetch } = {}): Promise<boolean> {
  let state: PendingRestart;
  try { state = JSON.parse(await readFile(path, "utf8")) as PendingRestart; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const now = options.now ?? Date.now();
  const valid = typeof state.applicationId === "string" && state.applicationId.length > 0
    && typeof state.token === "string" && state.token.length > 0
    && typeof state.createdAt === "number" && Number.isFinite(state.createdAt)
    && now >= state.createdAt && now - state.createdAt <= RESTART_TOKEN_TTL_MS;
  if (!valid) { await rm(path, { force: true }); return false; }
  const request = options.fetch ?? fetch;
  const url = `https://discord.com/api/v10/webhooks/${encodeURIComponent(state.applicationId)}/${encodeURIComponent(state.token)}/messages/@original`;
  const response = await request(url, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: `${botName} says Hi again 🫶🏻` }) });
  if (!response.ok) throw new Error(`Discord restart completion edit failed: ${response.status} ${await response.text()}`);
  await rm(path, { force: true });
  return true;
}
