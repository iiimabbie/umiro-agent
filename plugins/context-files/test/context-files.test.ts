import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createPlugin, renderToolEvidenceLedger, TOOL_EVIDENCE_LIMIT } from "../src/index.js";

const exec = promisify(execFile);
const memoryFiles = async (root: string) => {
  await mkdir(join(root, "memory"), { recursive: true });
  const contents = {
    PREFERENCES: "# PREFERENCES\n\nPreferences.\n\n## Lead with outcome\nGive the result first.\n",
    LESSONS: "# LESSONS\n\nLessons.\n\n## Verify changes\nCheck the actual result.\n",
    WORKFLOWS: "# WORKFLOWS\n\nWorkflows.\n\n## Deploy safely\nPrivate workflow details.\n",
    ONGOING: "# ONGOING\n\nOngoing.\n\n## V2 migration\nPrivate project details.\n",
    FACTS: "# FACTS\n\nFacts.\n\n## Host names\nPrivate host details.\n",
  };
  await Promise.all(Object.entries(contents).map(([name, content]) => writeFile(join(root, "memory", `${name}.md`), content)));
};

test("built-in context provider loads OWNER with the other workspace files", async () => {
  const root = await mkdtemp(join(tmpdir(), "umiro-context-"));
  for (const [name, content] of [["SOUL.md", "soul"], ["AGENT.md", "agent"], ["OWNER.md", "owner"]] as const) await writeFile(join(root, name), content);
  await memoryFiles(root);
  const plugin = createPlugin({ pluginId: "context-files", namespace: "context-files", permissionCeiling: { capabilities: [], visibility: { kind: "all" }, instructionAuthority: "none" }, config: { workspacePath: root, skills: ["travel"] }, getSecret: () => undefined });
  await mkdir(join(root, "skills", "travel"), { recursive: true });
  await writeFile(join(root, "skills", "travel", "SKILL.md"), "---\nname: Traveler\ndescription: Plan trips\n---\n# Details\n");
  await plugin.start?.();
  const providers = plugin.contributions.contextProviders ?? [];
  assert.deepEqual(providers.map(provider => provider.id), ["context.bootstrap", "context.soul", "context.agent", "context.owner", "context.memory", "context.skills", "context.conversation_history"]);
  const request = { runId: "run", execution: { actor: { id: "owner", kind: "human", roles: ["owner"] } } as never, prompt: "hi" };
  const owner = await providers.find(provider => provider.id === "context.owner")!.load(request);
  assert.equal(owner[0]?.content, "owner");
  const memory = await providers.find(provider => provider.id === "context.memory")!.load(request);
  assert.match(memory[0]?.content ?? "", /<memory-preferences>[\s\S]*Give the result first[\s\S]*<memory-lessons>[\s\S]*Check the actual result/);
  assert.match(memory[0]?.content ?? "", /WORKFLOWS: Deploy safely[\s\S]*ONGOING: V2 migration[\s\S]*FACTS: Host names/);
  assert.doesNotMatch(memory[0]?.content ?? "", /Private workflow details|Private project details|Private host details/);
  const skills = await providers.find(provider => provider.id === "context.skills")!.load(request);
  assert.match(skills[0]?.content ?? "", /Traveler: Plan trips.*skills\/travel\/SKILL\.md/);
  const ownerTools = plugin.contributions.tools ?? [];
  const add = ownerTools.find(tool => tool.name === "owner_profile_add")!;
  const replace = ownerTools.find(tool => tool.name === "owner_profile_replace")!;
  assert.equal((await add.execute({ content: "稱呼：主人" }, {} as never) as { ok: boolean }).ok, true);
  assert.match(await (await import("node:fs/promises")).readFile(join(root, "OWNER.md"), "utf8"), /稱呼：主人/);
  assert.equal((await replace.execute({ oldText: "稱呼：主人", newText: "稱呼：Owner" }, {} as never) as { ok: boolean }).ok, true);
  const history = await providers.find(provider => provider.id === "context.conversation_history")!.load({ ...request, conversationCompaction: { conversationId: "c", throughSequence: 3, sourceHash: "abc", summary: "先前談過授權邊界", updatedAt: "now" }, recentHistory: [{ turn: { id: "t", conversationId: "c", sequence: 4, actorPrincipalId: "user", actorIdentity: { transport: "discord", externalId: "123456789012345678" }, inputEventId: "discord:e", content: [{ type: "text", text: "我叫小明" }], createdAt: "2026-09-12T00:00:00.000Z" }, actorDisplayName: "小明", assistantText: "記住了", assistantCreatedAt: "2026-09-12T00:00:02.000Z", toolEvidence: "Tool: discord_fetch_message\nResult: fetched message" }] });
  assert.deepEqual(history.map(block => block.id), ["context.conversation_history:compacted", "context.conversation_history:tool-evidence"]);
  assert.match(history[0]?.content ?? "", /先前談過授權邊界/);
  assert.match(history[1]?.content ?? "", /tool-evidence-ledger[\s\S]*fetched message/);
  assert.doesNotMatch(history[1]?.content ?? "", /我叫小明|記住了/);
  const reply = await providers.find(provider => provider.id === "context.conversation_history")!.load({ ...request, replyTarget: { turn: { id: "reply-turn", conversationId: "c", sequence: 1, actorPrincipalId: "user", inputEventId: "e-reply", content: [{ type: "text", text: "被回覆的內容" }], createdAt: "now" }, assistantText: "原本的回答" } });
  assert.match(reply[0]?.content ?? "", /discord-reply-target[\s\S]*被回覆的內容[\s\S]*原本的回答/);
  const fetchedReply = await providers.find(provider => provider.id === "context.conversation_history")!.load({ ...request, inputEvent: { metadata: { replyToMessageId: "discord-message-1", replyAuthorId: "member-1", replyToContent: "尚未入庫的被回覆訊息" } } as never });
  assert.match(fetchedReply[0]?.content ?? "", /external-message-id="discord-message-1"[\s\S]*尚未入庫的被回覆訊息/);
  await plugin.stop?.();
});

test("tool evidence ledger is globally bounded and newest-first", () => {
  const ledger = renderToolEvidenceLedger([
    { turn: { inputEventId: "old" }, toolEvidence: "old evidence ".repeat(500) },
    { turn: { inputEventId: "new" }, toolEvidence: "new evidence ".repeat(500) },
  ]);
  assert.ok(ledger.length <= TOOL_EVIDENCE_LIMIT);
  assert.match(ledger, /\[msg:new\]/);
  assert.doesNotMatch(ledger, /\[msg:old\]/);
});

test("bootstrap is owner-only and disappears after both identity files leave shipped templates", async () => {
  const root = await mkdtemp(join(tmpdir(), "umiro-bootstrap-"));
  await writeFile(join(root, "SOUL.md"), "# SOUL\n");
  await writeFile(join(root, "OWNER.md"), "# OWNER\n");
  await writeFile(join(root, "AGENT.md"), "agent\n");
  await memoryFiles(root);
  const plugin = createPlugin({ pluginId: "context-files", namespace: "context-files", permissionCeiling: { capabilities: [], visibility: { kind: "all" }, instructionAuthority: "none" }, config: { workspacePath: root }, getSecret: () => undefined });
  await plugin.start?.();
  await writeFile(join(root, "BOOTSTRAP.md"), "setup\n");
  const bootstrap = plugin.contributions.contextProviders!.find(provider => provider.id === "context.bootstrap")!;
  assert.equal((await bootstrap.load({ runId: "r", execution: { actor: { id: "member", kind: "human", roles: [] } } as never, prompt: "hi" })).length, 0);
  assert.equal((await bootstrap.load({ runId: "r", execution: { actor: { id: "owner", kind: "human", roles: ["owner"] } } as never, prompt: "hi" }))[0]?.content, "setup\n");
  await writeFile(join(root, "SOUL.md"), "# SOUL\nChosen voice\n");
  await writeFile(join(root, "OWNER.md"), "# OWNER\nChosen owner\n");
  await plugin.start?.();
  await assert.rejects(access(join(root, "BOOTSTRAP.md")));
  await plugin.stop?.();
});

test("skill tools install, list, activate immediately, persist config, and uninstall recoverably", async () => {
  const root = await mkdtemp(join(tmpdir(), "umiro-skills-workspace-"));
  const source = await mkdtemp(join(tmpdir(), "umiro-skill-source-"));
  const configFile = join(root, "umiro.json");
  await writeFile(configFile, `${JSON.stringify({ model: "test", skills: [] })}\n`);
  await writeFile(join(source, "SKILL.md"), "---\nname: Traveler\ndescription: Plan a trip\n---\n# Workflow\n");
  const plugin = createPlugin({ pluginId: "context-files", namespace: "context-files", permissionCeiling: { capabilities: [], visibility: { kind: "all" }, instructionAuthority: "none" }, config: { workspacePath: root, configFile, skills: [] }, getSecret: () => undefined });
  await plugin.start?.();
  const tools = plugin.contributions.tools ?? [];
  const install = tools.find(tool => tool.name === "skill_install")!;
  const list = tools.find(tool => tool.name === "skill_list")!;
  const uninstall = tools.find(tool => tool.name === "skill_uninstall")!;
  const context = { operationId: "op", signal: new AbortController().signal, execution: {} } as never;

  const installed = await install.execute({ source, name: "travel" }, context);
  assert.equal(installed.ok, true);
  assert.equal(installed.effectStatus, "confirmed");
  assert.deepEqual((JSON.parse(await readFile(configFile, "utf8")) as { skills: string[] }).skills, ["travel"]);
  const catalog = plugin.contributions.contextProviders!.find(provider => provider.id === "context.skills")!;
  assert.match((await catalog.load({ runId: "r", execution: { actor: { id: "owner", kind: "human", roles: ["owner"] } } as never, prompt: "" }))[0]?.content ?? "", /Traveler: Plan a trip/);
  const listed = await list.execute({}, context);
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.ok ? listed.output : undefined, { skills: [{ name: "travel", enabled: true, description: "Plan a trip" }] });

  const removed = await uninstall.execute({ name: "travel" }, context);
  assert.equal(removed.ok, true);
  assert.equal(removed.effectStatus, "confirmed");
  assert.deepEqual((JSON.parse(await readFile(configFile, "utf8")) as { skills: string[] }).skills, []);
  assert.equal((await catalog.load({ runId: "r", execution: { actor: { id: "owner", kind: "human", roles: ["owner"] } } as never, prompt: "" })).length, 0);
  await assert.rejects(access(join(root, "skills", "travel")));
  assert.ok((await readdir(join(root, ".trash"))).some(name => name.startsWith("skill-travel-")));
});

test("skill_install accepts a Git URL and rejects a repository without SKILL.md", async () => {
  const root = await mkdtemp(join(tmpdir(), "umiro-skills-git-workspace-"));
  const repository = await mkdtemp(join(tmpdir(), "umiro-skill-git-"));
  const invalidRepository = await mkdtemp(join(tmpdir(), "umiro-skill-invalid-git-"));
  const configFile = join(root, "umiro.json");
  await writeFile(configFile, `${JSON.stringify({ model: "test", skills: [] })}\n`);
  for (const [directory, skill] of [[repository, true], [invalidRepository, false]] as const) {
    await exec("git", ["init", directory]);
    if (skill) await writeFile(join(directory, "SKILL.md"), "---\ndescription: Git-installed skill\n---\n# Skill\n");
    else await writeFile(join(directory, "README.md"), "not a skill\n");
    await exec("git", ["-C", directory, "add", "."]);
    await exec("git", ["-C", directory, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture"]);
  }
  const plugin = createPlugin({ pluginId: "context-files", namespace: "context-files", permissionCeiling: { capabilities: [], visibility: { kind: "all" }, instructionAuthority: "none" }, config: { workspacePath: root, configFile, skills: [] }, getSecret: () => undefined });
  await plugin.start?.();
  const install = plugin.contributions.tools!.find(tool => tool.name === "skill_install")!;
  const context = { operationId: "op", signal: new AbortController().signal, execution: {} } as never;
  const installed = await install.execute({ source: `file://${repository}`, name: "from-git" }, context);
  assert.equal(installed.ok, true);
  assert.equal(installed.effectStatus, "confirmed");
  assert.match(await readFile(join(root, "skills", "from-git", "SKILL.md"), "utf8"), /Git-installed skill/);
  const invalid = await install.execute({ source: `file://${invalidRepository}`, name: "invalid" }, context);
  assert.equal(invalid.ok, false);
  assert.match(invalid.ok ? "" : invalid.error.message, /regular SKILL\.md/);
  await assert.rejects(access(join(root, "skills", "invalid")));
});
