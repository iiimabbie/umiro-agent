import type { ContextAssembly, ContextAssemblyRequest, ContextBlock } from "./contract.js";
import { ContextProviderRegistry } from "./registry.js";
import { contextBlockEnvelope, renderContextAssembly } from "./render.js";
import { HEURISTIC_CONTEXT_TOKEN_ESTIMATOR, type ContextTokenEstimator } from "./tokens.js";

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
  constructor(private readonly providers: ContextProviderRegistry, private readonly tokenEstimator: ContextTokenEstimator = HEURISTIC_CONTEXT_TOKEN_ESTIMATOR) {}

  async assemble(request: ContextAssemblyRequest): Promise<ContextAssembly> {
    if (!Number.isSafeInteger(request.maxCharacters) || request.maxCharacters < 0) {
      throw new TypeError("context maxCharacters must be a non-negative safe integer");
    }
    if (request.maxTokens !== undefined && (!Number.isSafeInteger(request.maxTokens) || request.maxTokens < 0)) throw new TypeError("context maxTokens must be a non-negative safe integer");

    const visible: ContextBlock[] = [];
    const seenBlockIds = new Set<string>();
    for (const block of request.precomputedBlocks ?? []) {
      validateBlock(block, block.providerId);
      if (block.influence !== "information" || block.instructionAuthority !== "none") throw new TypeError(`precomputed context block ${block.id} must be information-only`);
      if (seenBlockIds.has(block.id)) throw new Error(`duplicate context block id: ${block.id}`);
      seenBlockIds.add(block.id);
      visible.push(block);
    }
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
    let estimatedTokenCount = 0;
    const tokenCost = (block: ContextBlock) => this.tokenEstimator.estimate(JSON.stringify(contextBlockEnvelope(block)));
    const fits = (block: ContextBlock, characters = characterCount, tokens = estimatedTokenCount) => characters + block.content.length <= request.maxCharacters && (request.maxTokens === undefined || tokens + tokenCost(block) <= request.maxTokens);
    const essential = visible.filter(block => block.retention === "essential");
    for (const block of essential) {
      if (!fits(block)) {
        throw new Error(`essential context block exceeds budget: ${block.id}`);
      }
      included.push(block);
      characterCount += block.content.length;
      estimatedTokenCount += tokenCost(block);
    }

    const normal = visible.filter(block => block.retention !== "essential");
    const providerIds = [...new Set(normal.map(block => block.providerId))];
    const fairShare = providerIds.length ? Math.floor((request.maxCharacters - characterCount) / providerIds.length) : 0;
    const fairTokenShare = request.maxTokens === undefined || !providerIds.length ? undefined : Math.floor((request.maxTokens - estimatedTokenCount) / providerIds.length);
    const deferred: ContextBlock[] = [];
    for (const providerId of providerIds) {
      let providerCharacters = 0;
      let providerTokens = 0;
      for (const block of normal.filter(candidate => candidate.providerId === providerId)) {
        const tokens = tokenCost(block);
        if (providerCharacters + block.content.length <= fairShare && (fairTokenShare === undefined || providerTokens + tokens <= fairTokenShare) && fits(block)) {
          included.push(block);
          providerCharacters += block.content.length;
          characterCount += block.content.length;
          providerTokens += tokens;
          estimatedTokenCount += tokens;
        } else deferred.push(block);
      }
    }
    for (const block of deferred) {
      if (!fits(block)) continue;
      included.push(block);
      characterCount += block.content.length;
      estimatedTokenCount += tokenCost(block);
    }
    included.sort((left, right) => visible.indexOf(left) - visible.indexOf(right));
    let includedIds = new Set(included.map(block => block.id));
    let omittedBlockIds = visible.filter(block => !includedIds.has(block.id)).map(block => block.id);
    estimatedTokenCount = this.tokenEstimator.estimate(renderContextAssembly({ blocks: included, omittedBlockIds, characterCount, estimatedTokenCount }));
    while (request.maxTokens !== undefined && estimatedTokenCount > request.maxTokens) {
      const removable = included.findLastIndex(block => block.retention !== "essential");
      if (removable < 0) throw new Error("essential context envelope exceeds token budget");
      const [removed] = included.splice(removable, 1);
      characterCount -= removed!.content.length;
      includedIds = new Set(included.map(block => block.id));
      omittedBlockIds = visible.filter(block => !includedIds.has(block.id)).map(block => block.id);
      estimatedTokenCount = this.tokenEstimator.estimate(renderContextAssembly({ blocks: included, omittedBlockIds, characterCount, estimatedTokenCount: 0 }));
    }
    return { blocks: included, omittedBlockIds, characterCount, estimatedTokenCount };
  }
}
