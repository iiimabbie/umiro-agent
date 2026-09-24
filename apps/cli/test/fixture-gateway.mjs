import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const state = join(process.env.UMIRO_HOME, "state");
const ready = join(state, "gateway.ready");
await mkdir(state, { recursive: true });
if (process.env.UMIRO_TEST_ENV_CAPTURE) await writeFile(process.env.UMIRO_TEST_ENV_CAPTURE, JSON.stringify({ UMIRO_SERVICE_MANAGER: process.env.UMIRO_SERVICE_MANAGER, INVOCATION_ID: process.env.INVOCATION_ID }));
await writeFile(ready, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), checks: { storage: true, plugins: true, discord: true, scheduler: true, shuttingDown: false } })}\n`);
process.on("SIGTERM", () => { void rm(ready, { force: true }).finally(() => process.exit(0)); });
setInterval(() => {}, 60_000);
