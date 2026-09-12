import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Single installation root, overridable for tests and alternate user profiles. */
export function umiroHome(environment: NodeJS.ProcessEnv = process.env): string {
  return resolve(environment.UMIRO_HOME?.trim() || join(homedir(), ".umiro"));
}

export function umiroPaths(environment: NodeJS.ProcessEnv = process.env) {
  const root = umiroHome(environment);
  return {
    root,
    bin: join(root, "bin"),
    app: join(root, "app"),
    config: join(root, "config"),
    secrets: join(root, "config", "secrets.env"),
    workspace: join(root, "workspace"),
    data: join(root, "data"),
    artifacts: join(root, "data", "artifacts"),
    state: join(root, "state"),
    configFile: join(root, "config", "umiro.json"),
    sqlite: join(root, "data", "umiro.sqlite"),
  } as const;
}
