import assert from "node:assert/strict";
import test from "node:test";
import { ContextEngine, ContextProviderRegistry, type ContextBlock } from "../src/context/index.js";

const execution = { actor: { id: "owner", kind: "human" as const, roles: ["owner" as const] }, origin: { kind: "interactive" as const, transport: "test", conversationId: "c" }, authority: { capabilities: [], visibility: { kind: "all" as const }, instructionAuthority: "full" as const } };
const block = (id: string, content: string, retention?: "essential" | "normal"): ContextBlock => ({ id, providerId: id, role: id, content, source: { kind: "test", ref: id }, influence: "information", instructionAuthority: "none", ...(retention ? { retention } : {}) });

test("context budget reserves essential blocks and fails if they cannot fit", async () => {
  const registry = new ContextProviderRegistry();
  registry.register({ id: "large", role: "large", priority: 1, async load() { return [block("large", "12345678")]; } });
  registry.register({ id: "identity", role: "identity", priority: 2, async load() { return [block("identity", "soul", "essential")]; } });
  const engine = new ContextEngine(registry);
  const assembly = await engine.assemble({ runId: "r", execution, prompt: "", maxCharacters: 8 });
  assert.deepEqual(assembly.blocks.map(item => item.id), ["identity"]);
  assert.deepEqual(assembly.omittedBlockIds, ["large"]);
  await assert.rejects(engine.assemble({ runId: "r", execution, prompt: "", maxCharacters: 3 }), /essential context block exceeds budget/);
});

test("normal context providers receive a fair first-pass budget before unused space is reclaimed", async () => {
  const registry = new ContextProviderRegistry();
  registry.register({ id: "early", role: "memory", priority: 1, async load() { return [block("early", "12345678")]; } });
  registry.register({ id: "later", role: "people", priority: 2, async load() { return [block("later", "abcd")]; } });
  const assembly = await new ContextEngine(registry).assemble({ runId: "r", execution, prompt: "", maxCharacters: 8 });
  assert.deepEqual(assembly.blocks.map(item => item.id), ["later"]);
  assert.deepEqual(assembly.omittedBlockIds, ["early"]);
});

test("context provider tie ordering is locale-independent code-unit order", () => {
  const registry = new ContextProviderRegistry();
  registry.register({ id: "zeta", role: "test", priority: 1, async load() { return []; } });
  registry.register({ id: "alpha", role: "test", priority: 1, async load() { return []; } });
  assert.deepEqual(registry.list().map(provider => provider.id), ["alpha", "zeta"]);
});

test("context assembly enforces a rendered token ceiling through an injectable estimator", async () => {
  const registry = new ContextProviderRegistry();
  registry.register({ id: "first", role: "test", priority: 1, async load() { return [block("first", "one")]; } });
  registry.register({ id: "second", role: "test", priority: 2, async load() { return [block("second", "two")]; } });
  const estimator = { estimate(text: string) { return text.match(/"content":/g)?.length ?? 0; } };
  const assembly = await new ContextEngine(registry, estimator).assemble({ runId: "r", execution, prompt: "", maxCharacters: 100, maxTokens: 1 });
  assert.deepEqual(assembly.blocks.map(item => item.id), ["first"]);
  assert.equal(assembly.estimatedTokenCount, 1);
  assert.deepEqual(assembly.omittedBlockIds, ["second"]);
});

test("precomputed analyzer blocks share validation, budget and duplicate protection", async () => {
  const registry = new ContextProviderRegistry();
  registry.register({ id: "provider", role: "test", priority: 1, async load() { return [block("provider", "provider")]; } });
  const analyzerBlock = { ...block("analyzer", "advisory", "essential"), providerId: "intent.analysis" };
  const assembly = await new ContextEngine(registry).assemble({ runId: "r", execution, prompt: "", precomputedBlocks: [analyzerBlock], maxCharacters: 100 });
  assert.deepEqual(assembly.blocks.map(item => item.id), ["analyzer", "provider"]);
  await assert.rejects(new ContextEngine(registry).assemble({ runId: "r", execution, prompt: "", precomputedBlocks: [{ ...analyzerBlock, influence: "instruction" as const }], maxCharacters: 100 }), /information-only/);
  await assert.rejects(new ContextEngine(registry).assemble({ runId: "r", execution, prompt: "", precomputedBlocks: [analyzerBlock, analyzerBlock], maxCharacters: 100 }), /duplicate context block id/);
});
