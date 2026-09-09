import type { ModelCallRecord } from "@umiro/core";

export interface ModelPricing { readonly inputUsdPerMillion: number; readonly outputUsdPerMillion: number }

export function summarizeModelUsage(calls: readonly ModelCallRecord[], pricing: Readonly<Record<string, ModelPricing>> = {}) {
  const byModel: Record<string, { calls: number; inputTokens: number; outputTokens: number; reasoningTokens: number; estimatedCostMicrousd?: number }> = {};
  for (const call of calls) {
    const item = byModel[call.model] ??= { calls: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
    item.calls += 1;
    item.inputTokens += call.response.usage.inputTokens;
    item.outputTokens += call.response.usage.outputTokens;
    item.reasoningTokens += call.response.usage.reasoningTokens;
  }
  for (const [model, item] of Object.entries(byModel)) {
    const rate = pricing[model];
    if (rate) item.estimatedCostMicrousd = Math.round(item.inputTokens * rate.inputUsdPerMillion + item.outputTokens * rate.outputUsdPerMillion);
  }
  return {
    calls: Object.values(byModel).reduce((sum, item) => sum + item.calls, 0),
    inputTokens: Object.values(byModel).reduce((sum, item) => sum + item.inputTokens, 0),
    outputTokens: Object.values(byModel).reduce((sum, item) => sum + item.outputTokens, 0),
    reasoningTokens: Object.values(byModel).reduce((sum, item) => sum + item.reasoningTokens, 0),
    estimatedCostMicrousd: Object.values(byModel).every(item => item.estimatedCostMicrousd !== undefined) ? Object.values(byModel).reduce((sum, item) => sum + item.estimatedCostMicrousd!, 0) : undefined,
    byModel,
  };
}
