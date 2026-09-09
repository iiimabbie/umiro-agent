import type { JsonObject } from "../ports/json.js";

export interface CoreConfig {
  readonly schemaVersion: 1;
  readonly storage: {
    readonly sqlitePath: string;
  };
  readonly agentWorkspacePath: string;
  readonly plugins: readonly {
    readonly path: string;
    readonly enabled: boolean;
    readonly config?: JsonObject;
  }[];
  readonly logging: {
    readonly level: "debug" | "info" | "warn" | "error";
  };
}

export interface SecretSource {
  get(name: string): string | undefined;
}

export const CORE_CONFIG_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "storage", "agentWorkspacePath", "plugins", "logging"],
  properties: {
    schemaVersion: { const: 1 },
    storage: {
      type: "object",
      additionalProperties: false,
      required: ["sqlitePath"],
      properties: { sqlitePath: { type: "string", minLength: 1 } },
    },
    agentWorkspacePath: { type: "string", minLength: 1 },
    plugins: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "enabled"],
        properties: {
          path: { type: "string", minLength: 1 },
          enabled: { type: "boolean" },
          config: { type: "object" },
        },
      },
    },
    logging: {
      type: "object",
      additionalProperties: false,
      required: ["level"],
      properties: { level: { enum: ["debug", "info", "warn", "error"] } },
    },
  },
};
