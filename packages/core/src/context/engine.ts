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
    let characterCount = 0;
    const essential = visible.filter(block => block.retention === "essential");
    for (const block of essential) {
      if (characterCount + block.content.length > request.maxCharacters) {
        throw new Error(`essential context block exceeds budget: ${block.id}`);
      }
      included.push(block);
      characterCount += block.content.length;
    }

    const normal = visible.filter(block => block.retention !== "essential");
    const providerIds = [...new Set(normal.map(block => block.providerId))];
    const fairShare = providerIds.length ? Math.floor((request.maxCharacters - characterCount) / providerIds.length) : 0;
    const deferred: ContextBlock[] = [];
    for (const providerId of providerIds) {
      let providerCharacters = 0;
      for (const block of normal.filter(candidate => candidate.providerId === providerId)) {
        if (providerCharacters + block.content.length <= fairShare) {
          included.push(block);
          providerCharacters += block.content.length;
          characterCount += block.content.length;
        } else deferred.push(block);
      }
    }
    for (const block of deferred) {
      if (characterCount + block.content.length > request.maxCharacters) continue;
      included.push(block);
      characterCount += block.content.length;
    }
    included.sort((left, right) => visible.indexOf(left) - visible.indexOf(right));
    const includedIds = new Set(included.map(block => block.id));
    const omittedBlockIds = visible.filter(block => !includedIds.has(block.id)).map(block => block.id);
    return { blocks: included, omittedBlockIds, characterCount };
  }
}
