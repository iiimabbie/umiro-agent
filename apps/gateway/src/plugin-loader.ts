import { readFile, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { validatePluginManifest, type PluginInstance, type PluginManifestV0, type PluginModule, type PluginSetupContext } from "@umiro/core/plugin";

interface PluginEntryModule {
  readonly createPlugin?: (context: PluginSetupContext) => PluginInstance | Promise<PluginInstance>;
}

function assertInside(root: string, candidate: string): void {
  const path = relative(root, candidate);
  if (path === "" || path === ".." || path.startsWith(`..${sep}`) || resolve(root, path) !== candidate) {
    throw new Error(`plugin entry escapes its directory: ${candidate}`);
  }
}

async function readManifest(pluginDirectory: string): Promise<PluginManifestV0> {
  const path = join(pluginDirectory, "umiro.plugin.json");
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`failed to read plugin manifest: ${path}`, { cause: error });
  }
  validatePluginManifest(value);
  return value;
}

/** Loads one explicitly configured plugin directory. Discovery policy lives above this function. */
export async function loadPluginModule(pluginDirectory: string): Promise<PluginModule> {
  const root = await realpath(pluginDirectory);
  const manifest = await readManifest(root);
  const entry = await realpath(join(root, manifest.entry));
  assertInside(root, entry);

  const imported = await import(pathToFileURL(entry).href) as PluginEntryModule;
  if (typeof imported.createPlugin !== "function") {
    throw new TypeError(`plugin entry ${entry} must export createPlugin()`);
  }
  return { manifest, create: imported.createPlugin };
}

export function pluginDirectoryFromManifestPath(manifestPath: string): string {
  return dirname(resolve(manifestPath));
}
