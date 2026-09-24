import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const cli = new URL("../src/main.js", import.meta.url).pathname;

async function prepareRoot(): Promise<{ root: string; home: string; source: string; bin: string; log: string }> {
  const root = await mkdtemp(join(tmpdir(), "umiro systemd install-"));
  const home = join(root, "home"); const source = join(root, "source"); const bin = join(root, "bin"); const log = join(root, "systemctl.log");
  await mkdir(join(source, "apps", "gateway"), { recursive: true });
  await mkdir(join(source, "templates", "workspace", "memory"), { recursive: true });
  await mkdir(bin);
  await writeFile(join(source, "pnpm-workspace.yaml"), "packages: []\n");
  for (const name of ["SOUL.md", "AGENT.md", "OWNER.md", "BOOTSTRAP.md"]) await writeFile(join(source, "templates", "workspace", name), `# ${name}\n`);
  for (const name of ["PREFERENCES.md", "LESSONS.md", "WORKFLOWS.md", "ONGOING.md", "FACTS.md"]) await writeFile(join(source, "templates", "workspace", "memory", name), `# ${name}\n`);
  await writeFile(join(bin, "git"), "#!/bin/sh\nprintf '%s\\n' testrev\n");
  await writeFile(join(bin, "pnpm"), "#!/bin/sh\nif [ \"$1\" = build ]; then exit 0; fi\nfor arg do destination=$arg; done\nmkdir -p \"$destination/dist/src\"\ncase \"$destination\" in */gateway) printf '// gateway\\n' > \"$destination/dist/src/main.js\";; */cli) printf '// cli\\n' > \"$destination/dist/src/main.js\";; *) printf '{\"schemaVersion\":0}' > \"$destination/umiro.plugin.json\";; esac\n");
  await writeFile(join(bin, "systemctl"), "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$FAKE_SYSTEMCTL_LOG\"\nif [ \"${FAKE_SYSTEMCTL_FAIL:-0}\" = 1 ]; then echo 'fake systemd failure' >&2; exit 1; fi\nexit 0\n");
  await writeFile(join(bin, "loginctl"), "#!/bin/sh\nif [ \"${FAKE_LOGINCTL_FAIL:-0}\" = 1 ]; then echo 'fake loginctl failure' >&2; exit 1; fi\nprintf '%s\\n' \"${FAKE_LINGER:-no}\"\n");
  for (const name of ["git", "pnpm", "systemctl", "loginctl"]) await chmod(join(bin, name), 0o700);
  return { root, home, source, bin, log };
}

function regexEscape(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function systemdPath(value: string): string {
  let escaped = "";
  for (const byte of Buffer.from(value)) {
    const character = String.fromCharCode(byte);
    if (/[A-Za-z0-9_./:+@-]/.test(character)) escaped += character;
    else if (character === "%") escaped += "%%";
    else escaped += `\\x${byte.toString(16).padStart(2, "0")}`;
  }
  return escaped;
}

function environment(root: Awaited<ReturnType<typeof prepareRoot>>, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${root.bin}:${process.env.PATH ?? ""}`, UMIRO_HOME: root.home, UMIRO_SOURCE_DIR: root.source, FAKE_SYSTEMCTL_LOG: root.log, ...extra };
}

test("install enables systemd without starting it and records absolute Node plus linger guidance", async () => {
  const root = await prepareRoot();
  try {
    const result = await exec(process.execPath, [cli, "install"], { env: environment(root, { FAKE_LINGER: "no" }) });
    const unit = await readFile(join(root.home, "state", "umiro.service"), "utf8");
    assert.match(unit, new RegExp(`ExecStart=\"${regexEscape(process.execPath)}\" \"${regexEscape(join(root.home, "app", "current", "gateway", "dist", "src", "main.js"))}\"`));
    assert.match(unit, new RegExp(`Environment=\"UMIRO_HOME=${regexEscape(root.home)}\"`));
    assert.match(unit, /Environment=\"UMIRO_SERVICE_MANAGER=systemd\"/);
    assert.match(unit, new RegExp(`EnvironmentFile=-${regexEscape(systemdPath(join(root.home, "config", "secrets.env")))}`));
    assert.match(unit, new RegExp(`WorkingDirectory=${regexEscape(systemdPath(join(root.home, "workspace")))}`));
    assert.match(result.stdout, /systemd user service enabled \(not started/);
    assert.match(result.stdout, /systemd linger: no/);
    assert.match(result.stdout, /sudo loginctl enable-linger/);
    assert.doesNotMatch(await readFile(root.log, "utf8"), /start/);
  } finally { await rm(root.root, { recursive: true, force: true }); }
});

test("install reports a systemd failure and falls back without hiding the reason", async () => {
  const root = await prepareRoot();
  try {
    const result = await exec(process.execPath, [cli, "install"], { env: environment(root, { FAKE_SYSTEMCTL_FAIL: "1" }) });
    assert.match(result.stdout, /daemon fallback available \(no boot auto-start\)/);
    assert.match(result.stdout, /fake systemd failure/);
    assert.match(await readFile(join(root.home, "state", "umiro.service"), "utf8"), /ExecStart=/);
  } finally { await rm(root.root, { recursive: true, force: true }); }
});

test("install reports enabled linger when loginctl says yes", async () => {
  const root = await prepareRoot();
  try {
    const result = await exec(process.execPath, [cli, "install"], { env: environment(root, { FAKE_LINGER: "yes" }) });
    assert.match(result.stdout, /systemd linger: yes \(starts at boot before login\)/);
  } finally { await rm(root.root, { recursive: true, force: true }); }
});

test("install reports unavailable linger checks without disabling the service", async () => {
  const root = await prepareRoot();
  try {
    const result = await exec(process.execPath, [cli, "install"], { env: environment(root, { FAKE_LOGINCTL_FAIL: "1" }) });
    assert.match(result.stdout, /systemd user service enabled/);
    assert.match(result.stdout, /systemd linger: unavailable/);
    assert.match(result.stdout, /fake loginctl failure/);
    assert.match(result.stdout, /sudo loginctl enable-linger <username>/);
  } finally { await rm(root.root, { recursive: true, force: true }); }
});
