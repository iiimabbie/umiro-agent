import { relative, resolve } from "node:path";

const SAFE_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,126}[A-Za-z0-9])?$/;

export function managedPluginPath(root: string, repository: string, workspace?: string): string {
  if (!SAFE_NAME.test(repository) || repository === "." || repository === "..") throw new Error(`unsafe plugin repository name: ${repository}`);
  if (workspace && (!SAFE_NAME.test(workspace) || workspace === "." || workspace === "..")) throw new Error(`unsafe plugin workspace name: ${workspace}`);
  const target = resolve(root, workspace ? `${repository}-${workspace}` : repository);
  const relation = relative(resolve(root), target);
  if (!relation || relation.startsWith("..") || relation.includes("/../")) throw new Error("plugin path escapes managed root");
  return target;
}
