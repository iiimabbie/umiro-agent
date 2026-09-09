import { join } from "node:path";
import type { CoreConfig, SecretSource } from "@umiro/core/config";
import type { PluginHost } from "@umiro/core/plugin";
import { loadPluginModule } from "./plugin-loader.js";

export async function enableConfiguredPlugins(
  config: CoreConfig,
  host: PluginHost,
  secrets: SecretSource,
): Promise<void> {
  for (const configured of config.plugins) {
    if (!configured.enabled) continue;
    const module = await loadPluginModule(configured.path);
    const requiredSecrets = Object.fromEntries(
      (module.manifest.requiredSecrets ?? []).flatMap(name => {
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

export function pluginStateDirectory(dataDirectory: string, namespace: string): string {
  return join(dataDirectory, "plugins", namespace);
}
