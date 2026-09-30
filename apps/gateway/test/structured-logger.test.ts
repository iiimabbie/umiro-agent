import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { HumanReadableLogger, formatLogRecord } from "../src/structured-logger.js";

test("human-readable logger formats valid timestamps in the configured timezone", () => {
  const record = { level: "info", event: "event", message: "message", occurredAt: "2026-09-30T01:31:36.475Z" };
  const moduleUrl = new URL("../src/structured-logger.js", import.meta.url).href;
  const script = `import { formatLogRecord } from ${JSON.stringify(moduleUrl)};\nconst record = ${JSON.stringify(record)};\nprocess.stdout.write(formatLogRecord(record));`;

  const formatInTimezone = (timezone: string) => execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, TZ: timezone },
    encoding: "utf8",
  });

  assert.equal(formatInTimezone("UTC"), "2026-09-30 01:31:36 | INFO | event — message");
  assert.equal(formatInTimezone("Asia/Taipei"), "2026-09-30 09:31:36 | INFO | event — message");
});

test("human-readable logger emits every field as one escaped line", () => {
  let output = "";
  const logger = new HumanReadableLogger(line => { output += line; });
  const record = { level: "error" as const, event: 'plugin."hook"\nfailed', message: "Plugin hook\nfailed", occurredAt: "2026-09-30T00:00:00.000Z\nextra", pluginId: "sample", runId: "run-1", data: { z: { nested: true }, count: 2, a: "quote\" and\nnewline", "bad\nkey": "retained" } };
  logger.write(record);
  assert.equal(output.endsWith("\n"), true);
  const line = output.slice(0, -1);
  assert.equal(line.includes("\n"), false);
  assert.match(line, /^2026-09-30T00:00:00\.000Z\\nextra \| ERROR \|/);
  assert.equal(line, formatLogRecord(record));
  assert.ok(line.indexOf("runId=") < line.indexOf("pluginId="));
  assert.ok(line.indexOf("a=") < line.indexOf("count=") && line.indexOf("count=") < line.indexOf("z="));
  assert.match(line, /plugin\.\"hook\"\\nfailed/);
  assert.match(line, /Plugin hook\\nfailed/);
  assert.doesNotMatch(line, /\"plugin\.\\\"hook/);
  assert.match(line, /a=\"quote\\\" and\\nnewline\"/);
  assert.match(line, /nested/);
});

test("human-readable logger retains only a bounded newest-first structured view", () => {
  const logger = new HumanReadableLogger(() => undefined, 2);
  for (const event of ["one", "two", "three"]) logger.write({ level: "info", event, message: event, occurredAt: event });
  assert.deepEqual(logger.list(2).map(record => record.event), ["three", "two"]);
  assert.throws(() => logger.list(3), /between 1 and 2/);
});
