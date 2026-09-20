import type { TurnAnalysis } from "@umiro/core/plugin";
import type { DiscordTriggerDecision } from "@umiro/adapter-discord";

export type DiscordIngressRoute =
  | { readonly kind: "ignore" }
  | { readonly kind: "observe"; readonly analysis?: TurnAnalysis }
  | { readonly kind: "trigger"; readonly analysis?: TurnAnalysis };

/** Apply the hard trigger policy before consulting the optional advisory analyzer. */
export async function analyzeDiscordIngress(input: {
  readonly decision: DiscordTriggerDecision;
  readonly text: string;
  readonly analyze: () => Promise<TurnAnalysis | undefined>;
}): Promise<DiscordIngressRoute> {
  if (input.decision.disposition === "ignore") return { kind: "ignore" };
  let analysis: TurnAnalysis | undefined;
  if (input.text.trim()) {
    try { analysis = await input.analyze(); }
    catch { analysis = undefined; }
  }
  return (analysis?.shouldReply ?? input.decision.disposition === "trigger")
    ? { kind: "trigger", ...(analysis ? { analysis } : {}) }
    : { kind: "observe", ...(analysis ? { analysis } : {}) };
}
