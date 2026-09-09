import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import type { ModelFunctionTool } from "../model/contract.js";
import type { ToolDefinition } from "./contract.js";

export interface ToolInputValidation {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

interface RegisteredTool {
  readonly definition: ToolDefinition;
  readonly validate: ValidateFunction<unknown>;
}

function formatError(error: ErrorObject): string {
  const location = error.instancePath || "/";
  return `${location} ${error.message ?? "is invalid"}`;
}

export class ToolRegistry {
  private readonly ajv = new Ajv({ allErrors: true, strict: true });
  private readonly tools = new Map<string, RegisteredTool>();

  register(definition: ToolDefinition): void {
    if (!/^[a-z][a-z0-9_.-]{0,127}$/.test(definition.name)) {
      throw new TypeError(`invalid tool name: ${definition.name}`);
    }
    if (!definition.description.trim()) throw new TypeError(`tool ${definition.name} requires a description`);
    if (!definition.policy.capability.trim()) throw new TypeError(`tool ${definition.name} requires a capability`);
    if (definition.inputSchema.type !== "object") throw new TypeError(`tool ${definition.name} input schema root must be an object`);
    if (definition.policy.timeoutMs !== undefined
      && (!Number.isSafeInteger(definition.policy.timeoutMs) || definition.policy.timeoutMs <= 0)) {
      throw new TypeError(`tool ${definition.name} timeout must be a positive integer`);
    }
    if (this.tools.has(definition.name)) throw new Error(`duplicate tool registration: ${definition.name}`);

    const validate = this.ajv.compile(structuredClone(definition.inputSchema));
    this.tools.set(definition.name, { definition, validate });
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)?.definition;
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  validateInput(name: string, input: Record<string, unknown>): ToolInputValidation {
    const registered = this.tools.get(name);
    if (!registered) return { valid: false, errors: [`unknown tool: ${name}`] };
    const valid = registered.validate(input);
    return {
      valid,
      errors: valid ? [] : (registered.validate.errors ?? []).map(formatError),
    };
  }

  modelDefinitions(): readonly ModelFunctionTool[] {
    return [...this.tools.values()]
      .map(({ definition }) => ({
        name: definition.name,
        description: definition.description,
        parameters: structuredClone(definition.inputSchema),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  list(): readonly ToolDefinition[] {
    return [...this.tools.values()]
      .map(value => value.definition)
      .sort((left, right) => left.name.localeCompare(right.name));
  }
}
