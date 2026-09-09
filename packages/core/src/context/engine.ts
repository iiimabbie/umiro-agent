import type { ContextAssembly, ContextAssemblyRequest, ContextBlock } from "./contract.js";
import { ContextProviderRegistry } from "./registry.js";

export class ContextProviderLoadError extends Error {
  constructor(readonly providerId: string, options?: ErrorOptions) {
    super(`context provider failed: ${providerId}`, options);
    this.name = "ContextProviderLoadError";
  }
}

function validateBlock(block: ContextBlock, providerId: string): void {
  if (!block.id.trim()) throw new TypeError(`context provider ${providerId} returned a block without an id`);
  if (block.providerId !== providerId) {
    throw new TypeError(`context block ${block.id} declares provider ${block.providerId}, expected ${providerId}`);
  }
  if (!block.role.trim()) throw new TypeError(`context block ${block.id} requires a role`);
  if (!block.content.trim()) throw new TypeError(`context block ${block.id} is empty`);
  if (!block.source.kind.trim() || !block.source.ref.trim()) {
    throw new TypeError(`context block ${block.id} requires a source kind and ref`);
  }
}

export class ContextEngine {
  constructor(private readonly providers: ContextProviderRegistry) {}

  async assemble(request: ContextAssemblyRequest): Promise<ContextAssembly> {
    if (!Number.isSafeInteger(request.maxCharacters) || request.maxCharacters < 0) {
      throw new TypeError("context maxCharacters must be a non-negative safe integer");
    }

    const visible: ContextBlock[] = [];
    const seenBlockIds = new Set<string>();
    for (const provider of this.providers.list()) {
      if (provider.requiredCapability
        && !request.execution.authority.capabilities.includes(provider.requiredCapability)) {
        continue;
      }
      let blocks: readonly ContextBlock[];
      try {
        blocks = await provider.load(request);
      } catch (error) {
        throw new ContextProviderLoadError(provider.id, { cause: error });
      }
      for (const block of blocks) {
        validateBlock(block, provider.id);
        if (seenBlockIds.has(block.id)) throw new Error(`duplicate context block id: ${block.id}`);
        seenBlockIds.add(block.id);
        visible.push(block);
      }
    }

    const included: ContextBlock[] = [];
    const omittedBlockIds: string[] = [];
    let characterCount = 0;
    const ordered = [...visible.filter(block => block.retention === "essential"), ...visible.filter(block => block.retention !== "essential")];
    for (const block of ordered) {
      if (characterCount + block.content.length > request.maxCharacters) {
        if (block.retention === "essential") throw new Error(`essential context block exceeds budget: ${block.id}`);
        omittedBlockIds.push(block.id);
        continue;
      }
      included.push(block);
      characterCount += block.content.length;
    }
    included.sort((left, right) => visible.indexOf(left) - visible.indexOf(right));
    return { blocks: included, omittedBlockIds, characterCount };
  }
}
