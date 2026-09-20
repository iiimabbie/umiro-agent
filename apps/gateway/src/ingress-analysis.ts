import type { TurnAnalysis } from "@umiro/core/plugin";
import type { DiscordTriggerDecision } from "@umiro/adapter-discord";

const ANALYSIS_CONTEXT_LIMIT = 10_000;

export interface DiscordAnalysisHistoryEntry {
  readonly userText: string;
  readonly assistantText?: string;
}

export function buildDiscordAnalysisText(currentText: string, history: readonly DiscordAnalysisHistoryEntry[]): string {
  const current = currentText.trim();
  const prior = history.flatMap(item => {
    const user = item.userText.trim();
    const assistant = item.assistantText?.trim();
    return [...(user ? [`User: ${user}`] : []), ...(assistant ? [`Assistant: ${assistant}`] : [])];
  });
  if (!prior.length) return currentText;
  const suffix = `\n\nCurrent message:\n${current}`;
  const header = "Recent messages from this same Discord conversation are context only. Use them to resolve references in the current message:\n";
  const available = Math.max(0, ANALYSIS_CONTEXT_LIMIT - header.length - suffix.length);
  const context = prior.join("\n").slice(-available);
  return `${header}${context}${suffix}`;
}

export type DiscordIngressRoute =
  | { readonly kind: "ignore" }
  | { readonly kind: "observe"; readonly analysis?: TurnAnalysis }
  | { readonly kind: "trigger"; readonly analysis?: TurnAnalysis };

/** Keep transport trigger policy authoritative; analysis may only refine an existing trigger. */
export async function analyzeDiscordIngress(input: {
  readonly decision: DiscordTriggerDecision;
  readonly text: string;
  readonly analyze: () => Promise<TurnAnalysis | undefined>;
}): Promise<DiscordIngressRoute> {
  if (input.decision.disposition === "ignore") return { kind: "ignore" };
  if (input.decision.disposition === "observe") return { kind: "observe" };
  let analysis: TurnAnalysis | undefined;
  if (input.text.trim()) {
    try { analysis = await input.analyze(); }
    catch { analysis = undefined; }
  }
  return (analysis?.shouldReply ?? true)
    ? { kind: "trigger", ...(analysis ? { analysis } : {}) }
    : { kind: "observe", ...(analysis ? { analysis } : {}) };
}
