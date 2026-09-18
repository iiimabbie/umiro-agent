import { readFile, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { validatePluginManifest, type PluginInstance, type PluginManifestV0, type PluginModule, type PluginSetupContext } from "@umiro/core";

interface PluginEntry { readonly createPlugin?: (context: PluginSetupContext) => PluginInstance | Promise<PluginInstance> }

function assertInside(root: string, candidate: string): void {
  const path = relative(root, candidate);
  if (path === "" || path === ".." || path.startsWith(`..${sep}`) || resolve(root, path) !== candidate) throw new Error(`plugin entry escapes its directory: ${candidate}`);
}

export async function loadPluginModule(pluginDirectory: string): Promise<PluginModule> {
  const root = await realpath(pluginDirectory);
  const manifestPath = join(root, "umiro.plugin.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as PluginManifestV0;
  validatePluginManifest(manifest);
  const entry = await realpath(join(root, manifest.entry));
  assertInside(root, entry);
  const imported = await import(pathToFileURL(entry).href) as PluginEntry;
  if (typeof imported.createPlugin !== "function") throw new TypeError(`plugin entry ${entry} must export createPlugin()`);
  return { manifest, create: imported.createPlugin };
}

export function pluginDirectoryFromManifestPath(manifestPath: string): string { return dirname(resolve(manifestPath)); }
