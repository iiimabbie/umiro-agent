import { capabilities, type Authority, type InstructionAuthority, type VisibilityScope } from "@umiro/core";

export interface AuthorityConfigEntry {
  readonly capabilities?: readonly string[];
  readonly visibility?: VisibilityScope;
  readonly instructionAuthority?: InstructionAuthority;
}

export interface RuntimeAuthorityConfig {
  readonly owner?: AuthorityConfigEntry;
  readonly member?: AuthorityConfigEntry;
}

export const DEFAULT_MEMBER_CAPABILITIES = capabilities(
  "web.fetch", "scheduler.write", "memory.search", "memory.write", "people.write",
  "subagent.delegate", "discord.message.react", "discord.message.read",
  "model.hosted_web_search", "model.hosted_image_generation", "tool.catalog",
);

function selectedCapabilities(requested: readonly string[] | undefined, defaults: readonly string[], available: readonly string[], label: string): readonly string[] {
  const selected = capabilities(...(requested ?? defaults));
  const availableSet = new Set(available);
  const unavailable = selected.find(capability => !availableSet.has(capability));
  if (unavailable) throw new TypeError(`${label} requests unavailable capability: ${unavailable}`);
  return selected;
}

export function resolveRuntimeAuthorities(config: RuntimeAuthorityConfig | undefined, availableCapabilities: readonly string[], discordChannels: readonly string[]): { readonly ownerAuthority: Authority; readonly memberAuthority: Authority } {
  const ownerAuthority: Authority = {
    capabilities: selectedCapabilities(config?.owner?.capabilities, availableCapabilities, availableCapabilities, "authority.owner"),
    visibility: config?.owner?.visibility ?? { kind: "all" },
    instructionAuthority: config?.owner?.instructionAuthority ?? "full",
  };
  const defaultMemberVisibility: VisibilityScope = {
    kind: "restricted",
    principalIds: [],
    labels: ["public-web"],
    resources: [...new Set(discordChannels)].map(id => ({ kind: "discord-channel", id })),
  };
  const memberVisibility = config?.member?.visibility ?? defaultMemberVisibility;
  if (memberVisibility.kind !== "restricted") throw new TypeError("authority.member.visibility must be restricted");
  const memberAuthority: Authority = {
    capabilities: selectedCapabilities(config?.member?.capabilities, DEFAULT_MEMBER_CAPABILITIES.filter(capability => availableCapabilities.includes(capability)), availableCapabilities, "authority.member"),
    visibility: memberVisibility,
    instructionAuthority: config?.member?.instructionAuthority ?? "scoped",
  };
  return { ownerAuthority, memberAuthority };
}

export function validateAuthorityConfig(value: unknown): void {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("authority must be an object");
  const authority = value as Record<string, unknown>;
  const unexpected = Object.keys(authority).find(key => key !== "owner" && key !== "member");
  if (unexpected) throw new TypeError(`unsupported authority field: ${unexpected}`);
  for (const role of ["owner", "member"] as const) {
    const raw = authority[role];
    if (raw === undefined) continue;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError(`authority.${role} must be an object`);
    const entry = raw as Record<string, unknown>;
    const unknown = Object.keys(entry).find(key => !["capabilities", "visibility", "instructionAuthority"].includes(key));
    if (unknown) throw new TypeError(`unsupported authority.${role} field: ${unknown}`);
    if (entry.capabilities !== undefined && (!Array.isArray(entry.capabilities) || entry.capabilities.some(item => typeof item !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(item)) || new Set(entry.capabilities).size !== entry.capabilities.length)) throw new TypeError(`authority.${role}.capabilities must contain unique capability IDs`);
    if (entry.instructionAuthority !== undefined && !["full", "scoped", "none"].includes(String(entry.instructionAuthority))) throw new TypeError(`authority.${role}.instructionAuthority is invalid`);
    if (entry.visibility !== undefined) {
      const visibility = entry.visibility;
      if (!visibility || typeof visibility !== "object" || Array.isArray(visibility)) throw new TypeError(`authority.${role}.visibility must be an object`);
      const scope = visibility as Record<string, unknown>;
      if (scope.kind === "all") {
        if (Object.keys(scope).some(key => key !== "kind")) throw new TypeError(`authority.${role}.visibility all scope contains unsupported fields`);
      } else if (scope.kind === "restricted") {
        if (Object.keys(scope).some(key => !["kind", "principalIds", "labels", "resources"].includes(key)) || !Array.isArray(scope.principalIds) || scope.principalIds.some(item => typeof item !== "string") || !Array.isArray(scope.labels) || scope.labels.some(item => typeof item !== "string") || !Array.isArray(scope.resources) || scope.resources.some(item => !item || typeof item !== "object" || Array.isArray(item) || typeof (item as { kind?: unknown }).kind !== "string" || typeof (item as { id?: unknown }).id !== "string")) throw new TypeError(`authority.${role}.visibility restricted scope is invalid`);
      } else throw new TypeError(`authority.${role}.visibility kind is invalid`);
    }
  }
  const member = authority.member as Record<string, unknown> | undefined;
  if ((member?.visibility as { kind?: unknown } | undefined)?.kind === "all") throw new TypeError("authority.member.visibility must be restricted");
}
