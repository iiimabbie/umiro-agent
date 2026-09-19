import type { CoreConfig, SecretSource } from "@umiro/core/config";
import type { PluginHost, PluginManifestV0, PluginModule } from "@umiro/core/plugin";
import { loadPluginModule } from "./plugin-loader.js";

export interface PluginEnableEntry<T> { readonly configured: T; readonly module: PluginModule }

export function pluginSecretsFromEnvironment(manifest: PluginManifestV0, environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries([...(manifest.requiredSecrets ?? []), ...(manifest.optionalSecrets ?? [])].flatMap(name => {
    const value = environment[name];
    return value?.trim() ? [[name, value]] : [];
  }));
}

/** Resolve manifest-declared tool dependencies without making the user's
 * plugins.json order part of the Plugin API. Registration still fails closed
 * when a required tool has no provider or when dependencies are cyclic. */
export function orderPluginEnableEntries<T>(entries: readonly PluginEnableEntry<T>[]): readonly PluginEnableEntry<T>[] {
  const providers = new Map<string, number[]>();
  entries.forEach((entry, index) => {
    for (const tool of entry.module.manifest.contributes.tools ?? []) providers.set(tool, [...(providers.get(tool) ?? []), index]);
  });
  const dependencies = entries.map((entry, index) => {
    const required = (entry.module.manifest.contributes.subagentProfiles ?? []).flatMap(profile => profile.requiredTools ?? []);
    return new Set(required.flatMap(tool => providers.get(tool) ?? []).filter(provider => provider !== index));
  });
  const remaining = new Set(entries.map((_entry, index) => index));
  const ordered: PluginEnableEntry<T>[] = [];
  while (remaining.size) {
    const ready = [...remaining].filter(index => [...dependencies[index]!].every(dependency => !remaining.has(dependency)));
    if (!ready.length) {
      const ids = [...remaining].map(index => entries[index]!.module.manifest.id).sort().join(", ");
      throw new TypeError(`cyclic plugin tool dependencies: ${ids}`);
    }
    for (const index of ready) { remaining.delete(index); ordered.push(entries[index]!); }
  }
  return ordered;
}

export async function enableConfiguredPlugins(
  config: CoreConfig,
  host: PluginHost,
  secrets: SecretSource,
): Promise<void> {
  for (const configured of config.plugins) {
    if (!configured.enabled) continue;
    const module = await loadPluginModule(configured.path);
    const requiredSecrets = Object.fromEntries(
      [...(module.manifest.requiredSecrets ?? []), ...(module.manifest.optionalSecrets ?? [])].flatMap(name => {
        const value = secrets.get(name);
        return value === undefined ? [] : [[name, value]];
      }),
    );
    await host.enable(module, {
      ...(configured.config ? { config: configured.config } : {}),
      secrets: requiredSecrets,
    });
  }
}
