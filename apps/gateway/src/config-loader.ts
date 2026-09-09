import { readFile } from "node:fs/promises";
import { validateCoreConfig, type CoreConfig, type SecretSource } from "@umiro/core/config";

export async function loadCoreConfig(path: string): Promise<CoreConfig> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`failed to read Core config: ${path}`, { cause: error });
  }
  return validateCoreConfig(raw);
}

export class EnvironmentSecretSource implements SecretSource {
  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  get(name: string): string | undefined {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new TypeError(`invalid secret name: ${name}`);
    const value = this.environment[name];
    return value?.trim() ? value : undefined;
  }
}
