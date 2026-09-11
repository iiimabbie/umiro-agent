import assert from "node:assert/strict";
import test from "node:test";
import type { ApplicationCommandDataResolvable } from "discord.js";
import { applicationCommandData, syncApplicationCommands } from "../src/client.js";

function recorder(scope: string, calls: { scope: string; commands: readonly ApplicationCommandDataResolvable[] }[]) {
  return {
    async set(commands: readonly ApplicationCommandDataResolvable[]) {
      calls.push({ scope, commands });
    },
  };
}

test("command sync bulk-overwrites global and every current guild scope", async () => {
  const calls: { scope: string; commands: readonly ApplicationCommandDataResolvable[] }[] = [];
  const commands = applicationCommandData([
    { name: "models", description: "Select a model", options: [{ name: "name", description: "Model name", type: "string", required: true }] },
    { name: "stop", description: "Stop the active run", ownerOnly: true },
  ]);

  await syncApplicationCommands(recorder("global", calls), [recorder("guild-a", calls), recorder("guild-b", calls)], commands);

  assert.deepEqual(calls.map(call => call.scope).sort(), ["global", "guild-a", "guild-b"]);
  for (const call of calls) assert.deepEqual(call.commands, commands);
});

test("empty command manifest clears stale commands in every scope", async () => {
  const calls: { scope: string; commands: readonly ApplicationCommandDataResolvable[] }[] = [];
  await syncApplicationCommands(recorder("global", calls), [recorder("guild", calls)], applicationCommandData([]));
  assert.deepEqual(calls, [{ scope: "global", commands: [] }, { scope: "guild", commands: [] }]);
});
