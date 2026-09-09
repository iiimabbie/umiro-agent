import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, cp, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const cli = new URL("../src/main.js", import.meta.url).pathname;
const fixture = new URL("../../test/fixture-gateway.mjs", import.meta.url).pathname;

test("clean home completes install, configure, daemon, upgrade, backup, restore, rollback, and uninstall", async () => {
  const root = await mkdtemp(join(tmpdir(), "umiro-installer-rehearsal-")); const home = join(root, "home"); const source = join(root, "source"); const bin = join(root, "bin");
  await mkdir(join(source, "apps", "gateway"), { recursive: true }); await mkdir(join(source, "templates", "workspace"), { recursive: true }); await mkdir(bin);
  await writeFile(join(source, "pnpm-workspace.yaml"), "packages: []\n");
  for (const name of ["SOUL.md", "AGENT.md", "OWNER.md", "MEMORY.md"]) await writeFile(join(source, "templates", "workspace", name), `# ${name}\n`);
  await writeFile(join(bin, "git"), "#!/bin/sh\nprintf '%s\\n' \"${FAKE_REVISION:-testrev}\"\n");
  await writeFile(join(bin, "pnpm"), "#!/bin/sh\nif [ \"$1\" = build ]; then exit 0; fi\nfor arg do destination=$arg; done\nmkdir -p \"$destination/dist/src\"\ncase \"$destination\" in */gateway) printf '// gateway\\n' > \"$destination/dist/src/main.js\";; */cli) printf '// cli\\n' > \"$destination/dist/src/main.js\";; *) printf '{\"schemaVersion\":0}' > \"$destination/umiro.plugin.json\";; esac\n");
  await chmod(join(bin, "git"), 0o700); await chmod(join(bin, "pnpm"), 0o700);
  const environment = (revision: string) => ({ ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, UMIRO_HOME: home, UMIRO_SOURCE_DIR: source, UMIRO_NO_SYSTEMD: "1", UMIRO_GATEWAY_ENTRY: fixture, FAKE_REVISION: revision });
  try {
    await exec(process.execPath, [cli, "install"], { env: environment("rev1") });
    const first = await readlink(join(home, "app", "current")); assert.match(first, /rev1/);
    for (const name of ["SOUL.md", "AGENT.md", "OWNER.md", "MEMORY.md"]) await access(join(home, "workspace", name));

    const imported = join(root, "input.env"); await writeFile(imported, "DISCORD_TOKEN=test\nLLM_BASE_URL=http://127.0.0.1:1/v1\nLLM_API_KEY=test\nUMIRO_OWNER_DISCORD_ID=owner\n");
    await exec(process.execPath, [cli, "configure", "--from-env", imported], { env: environment("rev1") });
    assert.match(await readFile(join(home, "config", "secrets.env"), "utf8"), /UMIRO_WEB_UI_TOKEN=/);

    await exec(process.execPath, [cli, "start"], { env: environment("rev1") });
    assert.match((await exec(process.execPath, [cli, "status"], { env: environment("rev1") })).stdout, /\(ready\)/);
    await exec(process.execPath, [cli, "upgrade"], { env: environment("rev2") });
    const second = await readlink(join(home, "app", "current")); assert.match(second, /rev2/); assert.notEqual(second, first);
    assert.equal(await readlink(join(home, "app", "previous")), first);
    assert.match((await exec(process.execPath, [cli, "status"], { env: environment("rev2") })).stdout, /\(ready\)/);
    await exec(process.execPath, [cli, "stop"], { env: environment("rev2") });

    await mkdir(join(home, "data", "artifacts"), { recursive: true }); await writeFile(join(home, "data", "umiro.sqlite"), "database-v1"); await writeFile(join(home, "data", "artifacts", "a.txt"), "artifact-v1");
    const backup = join(root, "backup"); await exec(process.execPath, [cli, "backup", backup], { env: environment("rev2") });
    await writeFile(join(home, "data", "umiro.sqlite"), "database-v2"); await writeFile(join(home, "data", "artifacts", "a.txt"), "artifact-v2");
    const tampered = join(root, "tampered"); await cp(backup, tampered, { recursive: true }); await writeFile(join(tampered, "artifacts", "a.txt"), "tampered");
    await assert.rejects(exec(process.execPath, [cli, "restore", tampered], { env: environment("rev2") }), /backup integrity verification failed/);
    assert.equal(await readFile(join(home, "data", "umiro.sqlite"), "utf8"), "database-v2");
    await exec(process.execPath, [cli, "restore", backup], { env: environment("rev2") });
    assert.equal(await readFile(join(home, "data", "umiro.sqlite"), "utf8"), "database-v1"); assert.equal(await readFile(join(home, "data", "artifacts", "a.txt"), "utf8"), "artifact-v1");

    await exec(process.execPath, [cli, "rollback"], { env: environment("rev2") });
    assert.equal(await readlink(join(home, "app", "current")), first); assert.equal(await readlink(join(home, "app", "previous")), second);
    await exec(process.execPath, [cli, "uninstall"], { env: environment("rev2") });
    await access(join(home, "data", "umiro.sqlite")); await assert.rejects(access(join(home, "app")));
  } finally {
    try { await exec(process.execPath, [cli, "stop"], { env: environment("cleanup") }); } catch { /* best effort */ }
    await rm(root, { recursive: true, force: true });
  }
});
