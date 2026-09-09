import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ContextRequest } from "@umiro/core/context";
import { createPlugin, parsePeople, selectRelevantPeople } from "../src/index.js";

test("parses PEOPLE sections and Discord identities", () => {
  const people = parsePeople("# PEOPLE\n\n## 小明\n- Discord ID: 123\n- 別名: Ming／阿明\n\n朋友");
  assert.equal(people[0]?.heading, "小明");
  assert.equal(people[0]?.discordId, "123");
  assert.deepEqual(people[0]?.aliases, ["小明", "Ming", "阿明"]);
});

const request = (owner: boolean, externalId: string, prompt: string): ContextRequest => ({
  runId: "run", prompt,
  execution: { origin: { kind: "interactive", transport: "discord", conversationId: "conversation" }, actor: { id: owner ? "owner" : "member", kind: "human", roles: [owner ? "owner" : "member"], identities: [{ transport: "discord", externalId }] }, authority: { capabilities: ["people.write", "people.remove"], visibility: { kind: "all" }, instructionAuthority: "full" } },
});

test("ranks current author, mentions, replies, aliases and recent continuity for owner", () => {
  const entries = parsePeople("## A\n- Discord ID: 1\n- 別名: [\"Alice\"]\n\n## B\n- Discord ID: 2\n- 別名: [\"小白\"]\n\n## C\n- Discord ID: 3\n");
  const selected = selectRelevantPeople(entries, {
    ...request(true, "1", "問 Alice 和 <@2>"),
    inputEvent: { id: "event", occurredAt: "2026-01-01T00:00:00Z", identity: { transport: "discord", externalId: "1", principalId: "owner" }, conversation: { transport: "discord", externalId: "channel", kind: "channel" }, content: [{ type: "text", text: "問 Alice 和 <@2>" }], metadata: { replyAuthorId: "3" } },
  }, { maxEntries: 8, maxCharacters: 10_000 });
  assert.deepEqual(selected.map(entry => entry.discordId), ["1", "2", "3"]);
});

test("non-owner only receives their own card even when mentioning others", () => {
  const entries = parsePeople("## A\n- Discord ID: 1\n\n## B\n- Discord ID: 2\n");
  assert.deepEqual(selectRelevantPeople(entries, request(false, "2", "<@1>"), { maxEntries: 8, maxCharacters: 10_000 }).map(entry => entry.discordId), ["2"]);
});

test("plugin tools atomically add, update and remove PEOPLE entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "umiro-people-"));
  try {
    await writeFile(join(root, "PEOPLE.md"), "# PEOPLE\n");
    const plugin = createPlugin({ pluginId: "people", namespace: "people", permissionCeiling: { capabilities: ["people.write", "people.remove"], visibility: { kind: "all" }, instructionAuthority: "none" }, config: { workspacePath: root }, getSecret: () => undefined });
    await plugin.start?.();
    const tools = new Map(plugin.contributions.tools?.map(tool => [tool.name, tool]));
    const toolContext = { execution: request(true, "1", "").execution, operationId: "op", idempotencyKey: "key", signal: new AbortController().signal };
    assert.equal((await tools.get("people_add")!.execute({ content: "## Alice\n- Discord ID: 1\n- 別名: [\"Ally\"]" }, toolContext)).ok, true);
    assert.equal((await tools.get("people_update")!.execute({ oldText: "Ally", newText: "Alicia" }, toolContext)).ok, true);
    assert.match(await readFile(join(root, "PEOPLE.md"), "utf8"), /Alicia/);
    assert.equal((await tools.get("people_remove")!.execute({ text: "## Alice\n- Discord ID: 1\n- 別名: [\"Alicia\"]" }, toolContext)).ok, true);
    assert.doesNotMatch(await readFile(join(root, "PEOPLE.md"), "utf8"), /Alice/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
