import type { ModelMessage } from "../model/contract.js";
import { estimateModelMessageTokens } from "../model/estimate.js";

/** Reserve native history before providers spend the shared input budget. */
export function partitionContextTokenBudget(maxTokens: number, history: readonly ModelMessage[], current?: ModelMessage): { readonly contextMaxTokens: number; readonly reservedHistoryTokens: number } {
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 0) throw new TypeError("maxTokens must be a non-negative safe integer");
  const historyTokens = history.reduce((total, message) => total + estimateModelMessageTokens(message), 0);
  const reservedHistoryTokens = Math.min(Math.floor(maxTokens / 2), historyTokens);
  const currentTokens = current ? estimateModelMessageTokens(current) : 0;
  return { contextMaxTokens: Math.max(0, maxTokens - reservedHistoryTokens - currentTokens), reservedHistoryTokens };
}
