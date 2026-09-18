import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const cli = new URL("../src/main.js", import.meta.url).pathname;

test("init migrates the legacy embedding secret name without changing its value", async () => {
  const root = await mkdtemp(join(tmpdir(), "umiro-legacy-config-"));
  const home = join(root, "home");
  await mkdir(join(home, "config"), { recursive: true });
  await writeFile(join(home, "config", "plugins.json"), "[]\n");
  await writeFile(join(home, "config", "umiro.json"), `${JSON.stringify({ model: "model", embedding: { provider: "openai-compatible", model: "embedding", baseUrl: "https://example.test/v1", apiKeyEnv: "VOYAGE_API_KEY" } }, null, 2)}\n`);
  await writeFile(join(home, "config", "secrets.env"), "VOYAGE_API_KEY='secret value'\n");
  try {
    await exec(process.execPath, [cli, "init"], { env: { ...process.env, UMIRO_HOME: home } });
    const config = JSON.parse(await readFile(join(home, "config", "umiro.json"), "utf8")) as { embedding: Record<string, unknown> };
    assert.equal(config.embedding.apiKeyEnv, undefined);
    assert.match(await readFile(join(home, "config", "secrets.env"), "utf8"), /^UMIRO_EMBEDDING_API_KEY='secret value'$/m);
  } finally { await rm(root, { recursive: true, force: true }); }
});
