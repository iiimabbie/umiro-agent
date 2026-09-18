import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const cli = new URL("../src/main.js", import.meta.url).pathname;

test("CLI keeps embedding disabled by default and configures a user provider", async () => {
  const home = await mkdtemp(join(tmpdir(), "umiro-cli-embedding-"));
  const env = { ...process.env, UMIRO_HOME: home };
  try {
    await exec(process.execPath, [cli, "init"], { env });
    let config = JSON.parse(await readFile(join(home, "config", "umiro.json"), "utf8")) as { embedding: Record<string, unknown> };
    assert.deepEqual(config.embedding, { provider: "disabled" });

    await exec(process.execPath, [cli, "embedding", "configure", "--provider", "openai-compatible", "--model", "nomic-embed-text", "--base-url", "http://localhost:11434/v1", "--requests-per-minute", "3", "--recall-limit", "4", "--min-similarity", "0.5"], { env });
    config = JSON.parse(await readFile(join(home, "config", "umiro.json"), "utf8")) as { embedding: Record<string, unknown> };
    assert.deepEqual(config.embedding, { provider: "openai-compatible", model: "nomic-embed-text", requestsPerMinute: 3, recallLimit: 4, minSimilarity: 0.5 });
    const secrets = await readFile(join(home, "config", "secrets.env"), "utf8");
    assert.match(secrets, /^UMIRO_EMBEDDING_BASE_URL="http:\/\/localhost:11434\/v1"$/m);

    await exec(process.execPath, [cli, "embedding", "disable"], { env });
    config = JSON.parse(await readFile(join(home, "config", "umiro.json"), "utf8")) as { embedding: Record<string, unknown> };
    assert.deepEqual(config.embedding, { provider: "disabled" });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
