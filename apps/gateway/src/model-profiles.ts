import type { ModelCapability, ReasoningEffort } from "@umiro/core";
import { parseOpenAIProtocol, type OpenAIProtocol } from "./model-routing.js";

export type ConfigModelProfile = {
  readonly model: string;
  readonly protocol?: OpenAIProtocol;
  /** Undefined means inherit; an explicit empty array opts out. */
  readonly capabilities?: readonly ModelCapability[];
  readonly reasoningEffort?: ReasoningEffort;
};

export type RuntimeModelProfile = {
  readonly id: string;
  readonly model: string;
  readonly protocol: OpenAIProtocol;
  readonly capabilities: readonly ModelCapability[];
  readonly reasoningEffort?: ReasoningEffort;
};

export type ModelProfileConfig = {
  readonly model: string;
  readonly protocol?: OpenAIProtocol;
  readonly modelCapabilities?: readonly ModelCapability[];
  readonly profiles?: Record<string, ConfigModelProfile>;
};

export function compileModelProfiles(value: ModelProfileConfig): { defaultProtocol: OpenAIProtocol; defaultProfile: RuntimeModelProfile; profiles: Record<string, RuntimeModelProfile> } {
  const protocol = parseOpenAIProtocol(value.protocol);
  const defaultCapabilities = [...(value.modelCapabilities ?? [])];
  const defaultProfile: RuntimeModelProfile = { id: "default", model: value.model, protocol, capabilities: defaultCapabilities };
  const profiles = Object.fromEntries(Object.entries(value.profiles ?? {}).map(([id, profile]) => [id, {
    id,
    model: profile.model,
    protocol: parseOpenAIProtocol(profile.protocol ?? protocol, `profile ${id}.protocol`),
    capabilities: [...(profile.capabilities ?? defaultCapabilities)],
    ...(profile.reasoningEffort ? { reasoningEffort: profile.reasoningEffort } : {}),
  }])) as Record<string, RuntimeModelProfile>;
  return { defaultProtocol: protocol, defaultProfile, profiles };
}

export function resolveModelProfile(selection: string | undefined, defaultProfile: RuntimeModelProfile, profiles: Record<string, RuntimeModelProfile>): RuntimeModelProfile {
  if (!selection || selection === "default") return defaultProfile;
  const named = profiles[selection];
  if (named) return named;
  return { ...defaultProfile, id: selection, model: selection };
}
