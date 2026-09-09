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
