import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { StartupRecovery } from "@umiro/core";
import { SQLiteExecutionStore } from "../src/index.js";

const boundaries = [
  "model_before_call",
  "model_response_in_memory",
  "model_recorded",
  "tool_authorized",
  "tool_effect_applied",
  "tool_result_recorded",
] as const;

async function killAtBoundary(filename: string, boundary: string, marker: string): Promise<void> {
  const worker = spawn(process.execPath, [
    new URL("./fixtures/crash-worker.js", import.meta.url).pathname,
    filename,
    boundary,
    marker,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  worker.stdout.setEncoding("utf8");
  worker.stderr.setEncoding("utf8");
  worker.stdout.on("data", chunk => { stdout += chunk; });
  worker.stderr.on("data", chunk => { stderr += chunk; });
  while (!stdout.includes("READY") && worker.exitCode === null) {
    await Promise.race([once(worker.stdout, "data"), once(worker, "exit")]);
  }
  assert.match(stdout, /READY/, stderr);
  worker.kill("SIGKILL");
  await once(worker, "exit");
  assert.equal(worker.signalCode, "SIGKILL");
}

test("survives six real process-kill boundaries with durable recovery evidence", async () => {
  for (const boundary of boundaries) {
    const directory = mkdtempSync(join(tmpdir(), `umiro-crash-${boundary}-`));
    const filename = join(directory, "execution.db");
    const marker = join(directory, "external-effect.txt");
    try {
      await killAtBoundary(filename, boundary, marker);
      const store = new SQLiteExecutionStore(filename);
      try {
        const candidates = await new StartupRecovery(store, { now: () => "2026-09-09T02:05:00.000Z" }).prepare();
        assert.equal(candidates.length, 1, boundary);
        assert.equal(
          candidates[0]?.disposition,
          boundary === "tool_effect_applied" ? "manual_review" : "resume",
          boundary,
        );
        if (boundary === "tool_effect_applied") {
          assert.equal(existsSync(marker), true);
          assert.equal((await store.getOperation("operation-crash"))?.state, "outcome_unknown");
        }
        if (boundary === "model_recorded") assert.equal((await store.listModelCalls("run-crash")).length, 1);
        if (boundary === "tool_result_recorded") {
          assert.equal((await store.getOperationResult("operation-crash"))?.outcome, "succeeded");
        }
      } finally {
        store.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});
