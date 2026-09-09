import { Ajv } from "ajv";
import { CORE_CONFIG_SCHEMA, type CoreConfig } from "./contract.js";

const validateShape = new Ajv({ allErrors: true, strict: true }).compile<CoreConfig>(CORE_CONFIG_SCHEMA);
const SECRET_KEY = /(?:^|_)(?:api_?key|token|secret|password|credential)(?:$|_)/i;

export function assertConfigContainsNoSecrets(value: unknown, path = "config"): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertConfigContainsNoSecrets(item, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) throw new TypeError(`${path}.${key} looks like a secret and must use SecretSource`);
    assertConfigContainsNoSecrets(child, `${path}.${key}`);
  }
}

export function validateCoreConfig(value: unknown): CoreConfig {
  assertConfigContainsNoSecrets(value);
  if (!validateShape(value)) {
    const detail = validateShape.errors?.map(error => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`).join("; ");
    throw new TypeError(`invalid Core config: ${detail ?? "unknown schema violation"}`);
  }
  return structuredClone(value);
}
