import { Ajv } from "ajv";
import { isAuthoritySubset, isInstructionAuthorityAtMost, type Authority } from "../authorization/authority.js";
import { PLUGIN_API_VERSION, type PluginManifestV0 } from "./contract.js";

const ID = /^[a-z][a-z0-9_.-]{0,127}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const ENTRY = /^\.\/[A-Za-z0-9_./-]+\.js$/;

const validateShape = new Ajv({ allErrors: true, strict: true }).compile<PluginManifestV0>({
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "id", "version", "coreApi", "entry", "permissions", "namespace", "contributes"],
  properties: {
    schemaVersion: { const: 0 },
    id: { type: "string" },
    version: { type: "string" },
    coreApi: { const: PLUGIN_API_VERSION },
    entry: { type: "string" },
    namespace: { type: "string" },
    configSchema: { type: "object" },
    requiredSecrets: { type: "array", items: { type: "string" }, uniqueItems: true },
    permissions: {
      type: "object",
      additionalProperties: false,
      required: ["capabilities", "visibility", "instructionAuthority"],
      properties: {
        capabilities: { type: "array", items: { type: "string" }, uniqueItems: true },
        instructionAuthority: { enum: ["none", "scoped", "full"] },
        visibility: {
          oneOf: [
            {
              type: "object",
              additionalProperties: false,
              required: ["kind"],
              properties: { kind: { const: "all" } },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["kind", "principalIds", "labels", "resources"],
              properties: {
                kind: { const: "restricted" },
                principalIds: { type: "array", items: { type: "string" }, uniqueItems: true },
                labels: { type: "array", items: { type: "string" }, uniqueItems: true },
                resources: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["kind", "id"],
                    properties: { kind: { type: "string" }, id: { type: "string" } },
                  },
                },
              },
            },
          ],
        },
      },
    },
    contributes: {
      type: "object",
      additionalProperties: false,
      properties: {
        tools: { type: "array", items: { type: "string" }, uniqueItems: true },
        contextProviders: { type: "array", items: { type: "string" }, uniqueItems: true },
        hooks: { type: "array", items: { type: "string" }, uniqueItems: true },
        jobs: { type: "array", items: { type: "string" }, uniqueItems: true },
        commands: { type: "array", items: { type: "string" }, uniqueItems: true },
        skills: { type: "array", items: { type: "string" }, uniqueItems: true },
        policy: { type: "array", maxItems: 16, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 2000 } },
      },
    },
  },
});

function unique(values: readonly string[] | undefined, field: string, pattern = ID): void {
  if (!values) return;
  if (new Set(values).size !== values.length) throw new TypeError(`plugin manifest ${field} contains duplicates`);
  for (const value of values) {
    if (!pattern.test(value)) throw new TypeError(`plugin manifest ${field} contains an invalid id: ${value}`);
  }
}

export function validatePluginManifest(manifest: unknown, hostCeiling?: Authority): asserts manifest is PluginManifestV0 {
  if (!validateShape(manifest)) {
    const detail = validateShape.errors?.map(error => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`).join("; ");
    throw new TypeError(`invalid plugin manifest: ${detail ?? "unknown schema violation"}`);
  }
  if (manifest.schemaVersion !== 0) throw new TypeError("unsupported plugin manifest schema version");
  if (!ID.test(manifest.id)) throw new TypeError(`invalid plugin id: ${manifest.id}`);
  if (!VERSION.test(manifest.version)) throw new TypeError(`invalid plugin version: ${manifest.version}`);
  if (manifest.coreApi !== PLUGIN_API_VERSION) {
    throw new TypeError(`plugin ${manifest.id} requires unsupported Core API ${manifest.coreApi}`);
  }
  if (!ENTRY.test(manifest.entry) || manifest.entry.includes("..")) {
    throw new TypeError(`plugin ${manifest.id} entry must be a relative JavaScript path inside the plugin`);
  }
  if (!ID.test(manifest.namespace)) throw new TypeError(`invalid plugin namespace: ${manifest.namespace}`);
  unique(manifest.contributes.tools, "contributes.tools");
  unique(manifest.contributes.contextProviders, "contributes.contextProviders");
  unique(manifest.contributes.skills, "contributes.skills");
  if (manifest.contributes.policy?.some(item => !item.trim())) throw new TypeError("plugin manifest contributes.policy contains an empty policy");
  if ((manifest.contributes.policy?.reduce((total, item) => total + item.length, 0) ?? 0) > 8000) throw new TypeError("plugin manifest contributes.policy exceeds 8000 characters");
  unique(manifest.requiredSecrets, "requiredSecrets", /^[A-Z][A-Z0-9_]*$/);
  if (hostCeiling && !isAuthoritySubset(manifest.permissions, hostCeiling)) {
    throw new TypeError(`plugin ${manifest.id} permissions exceed the host ceiling`);
  }
  if (hostCeiling && manifest.contributes.policy?.length && !isInstructionAuthorityAtMost("scoped", hostCeiling.instructionAuthority)) {
    throw new TypeError(`plugin ${manifest.id} policy exceeds the host instruction authority ceiling`);
  }
}
