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
    optionalSecrets: { type: "array", items: { type: "string" }, uniqueItems: true },
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
        turnAnalyzers: { type: "array", items: { type: "string" }, uniqueItems: true },
        hooks: { type: "array", items: { type: "string" }, uniqueItems: true },
        jobs: { type: "array", items: { type: "string" }, uniqueItems: true },
        commands: { type: "array", items: { type: "string" }, uniqueItems: true },
        skills: { type: "array", items: { type: "string" }, uniqueItems: true },
        controlPanelViews: { type: "array", items: { type: "string" }, uniqueItems: true },
        policy: { type: "array", maxItems: 16, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 2000 } },
        subagentProfiles: {
          type: "array", maxItems: 16,
          items: {
            type: "object", additionalProperties: false,
            required: ["id", "description", "instructions"],
            properties: {
              id: { type: "string" }, description: { type: "string", minLength: 1 },
              instructions: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
              model: { type: "string", minLength: 1 },
              requiredTools: { type: "array", items: { type: "string" }, uniqueItems: true },
              authorityScope: {
                type: "object", additionalProperties: false,
                properties: {
                  capabilities: { type: "array", items: { type: "string" }, uniqueItems: true },
                  instructionAuthority: { enum: ["none", "scoped", "full"] },
                  visibility: {
                    oneOf: [
                      { type: "object", additionalProperties: false, required: ["kind"], properties: { kind: { const: "all" } } },
                      { type: "object", additionalProperties: false, required: ["kind", "principalIds", "labels", "resources"], properties: { kind: { const: "restricted" }, principalIds: { type: "array", items: { type: "string" }, uniqueItems: true }, labels: { type: "array", items: { type: "string" }, uniqueItems: true }, resources: { type: "array", items: { type: "object", additionalProperties: false, required: ["kind", "id"], properties: { kind: { type: "string" }, id: { type: "string" } } } } } },
                    ],
                  },
                },
              },
              budgetCeiling: { type: "object", additionalProperties: false, properties: { maxModelTurns: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, maxToolCalls: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, maxInputTokens: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, maxOutputTokens: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, maxDurationMs: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER } } },
              outputContract: { type: "object", additionalProperties: false, required: ["kind"], properties: { kind: { enum: ["text", "json", "artifact"] }, schema: { type: "object" } } },
            },
          },
        },
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
  unique(manifest.contributes.turnAnalyzers, "contributes.turnAnalyzers");
  unique(manifest.contributes.skills, "contributes.skills");
  unique(manifest.contributes.controlPanelViews, "contributes.controlPanelViews");
  unique(manifest.contributes.subagentProfiles?.map(profile => profile.id), "contributes.subagentProfiles");
  if (manifest.contributes.policy?.some(item => !item.trim())) throw new TypeError("plugin manifest contributes.policy contains an empty policy");
  if ((manifest.contributes.policy?.reduce((total, item) => total + item.length, 0) ?? 0) > 8000) throw new TypeError("plugin manifest contributes.policy exceeds 8000 characters");
  let totalProfileInstructions = 0;
  for (const profile of manifest.contributes.subagentProfiles ?? []) {
    if (!profile.description.trim()) throw new TypeError(`plugin manifest subagent profile ${profile.id} has an empty description`);
    if (!profile.instructions.length || profile.instructions.some(item => !item.trim())) throw new TypeError(`plugin manifest subagent profile ${profile.id} has empty instructions`);
    const length = profile.instructions.join("\n").length;
    if (length > 8000) throw new TypeError(`plugin manifest subagent profile ${profile.id} instructions exceed 8000 characters`);
    totalProfileInstructions += length;
    unique(profile.requiredTools, `subagent profile ${profile.id}.requiredTools`);
    const declared = new Set(manifest.permissions.capabilities);
    if (profile.authorityScope?.capabilities?.some(capability => !declared.has(capability))) throw new TypeError(`plugin manifest subagent profile ${profile.id} requires an undeclared capability`);
  }
  if (totalProfileInstructions > 32000) throw new TypeError("plugin manifest subagent profile instructions exceed 32000 characters in total");
  unique(manifest.requiredSecrets, "requiredSecrets", /^[A-Z][A-Z0-9_]*$/);
  unique(manifest.optionalSecrets, "optionalSecrets", /^[A-Z][A-Z0-9_]*$/);
  const requiredSecrets = new Set(manifest.requiredSecrets ?? []);
  const overlappingSecret = (manifest.optionalSecrets ?? []).find(secret => requiredSecrets.has(secret));
  if (overlappingSecret) throw new TypeError(`plugin manifest secret ${overlappingSecret} cannot be both required and optional`);
  if (hostCeiling && !isAuthoritySubset(manifest.permissions, hostCeiling)) {
    throw new TypeError(`plugin ${manifest.id} permissions exceed the host ceiling`);
  }
  if (hostCeiling && manifest.contributes.policy?.length && !isInstructionAuthorityAtMost("scoped", hostCeiling.instructionAuthority)) {
    throw new TypeError(`plugin ${manifest.id} policy exceeds the host instruction authority ceiling`);
  }
}

export function validatePluginConfig(manifest: PluginManifestV0, config: unknown): void {
  if (!manifest.configSchema) return;
  const validate = new Ajv({ allErrors: true, strict: true }).compile(manifest.configSchema);
  if (validate(config)) return;
  const detail = validate.errors?.map(error => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`).join("; ");
  throw new TypeError(`plugin ${manifest.id} config is invalid: ${detail ?? "unknown schema violation"}`);
}
