import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const cli = new URL("../src/main.js", import.meta.url).pathname;

test("Discord trigger policy is configurable through the installed CLI path", async () => {
  const home = await mkdtemp(join(tmpdir(), "umiro-cli-discord-"));
  const env = { ...process.env, UMIRO_HOME: home };
  try {
    await exec(process.execPath, [cli, "init"], { env });
    const initialized = JSON.parse(await readFile(join(home, "config", "umiro.json"), "utf8") as string) as { discord: Record<string, unknown> };
    assert.equal(initialized.discord.respondToBots, true);
    assert.equal(initialized.discord.queueMode, "queue");
    const autoArchive = (initialized as unknown as { conversation: { autoArchive: { enabled: boolean; time: string; timezone: string } } }).conversation.autoArchive;
    assert.deepEqual({ enabled: autoArchive.enabled, time: autoArchive.time }, { enabled: false, time: "00:00" });
    assert.doesNotThrow(() => new Intl.DateTimeFormat("en-US", { timeZone: autoArchive.timezone }).format());
    const token = (await exec(process.execPath, [cli, "web", "token"], { env })).stdout.trim();
    assert.match(token, /^[a-f0-9]{64}$/);
    await exec(process.execPath, [cli, "discord", "configure", "--allowed-guilds", "g1,g2", "--allowed-channels", "c1", "--ambient-channels", "a1,a2", "--ignored-channels", "i1", "--respond-to-bots", "true", "--queue-mode", "steer", "--status", "idle", "--activity", "testing"], { env });
    const config = JSON.parse(await readFile(join(home, "config", "umiro.json"), "utf8")) as { discord: Record<string, unknown> };
    assert.deepEqual(config.discord, { ignoredChannels: ["i1"], ambientChannels: ["a1", "a2"], allowedChannels: ["c1"], allowedGuilds: ["g1", "g2"], respondToBots: true, queueMode: "steer", presence: { status: "idle", activity: "testing" } });
    const status = await exec(process.execPath, [cli, "discord", "status"], { env });
    assert.deepEqual(JSON.parse(status.stdout), config.discord);
  } finally { await rm(home, { recursive: true, force: true }); }
});
