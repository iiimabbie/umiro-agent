import type { JsonObject } from "../ports/json.js";
import type { PluginCommandDefinition, PluginJobDefinition, SkillDefinition, SubagentProfileDefinition } from "./contract.js";

class ContributionRegistry<T extends { readonly id?: string; readonly name?: string }> {
  private readonly items = new Map<string, { pluginId: string; value: T }>();
  constructor(private readonly key: (value: T) => string, private readonly label: string) {}
  register(pluginId: string, value: T): void { const id = this.key(value); if (this.items.has(id)) throw new Error(`duplicate plugin ${this.label}: ${id}`); this.items.set(id, { pluginId, value }); }
  unregister(id: string): boolean { return this.items.delete(id); }
  list(): readonly T[] { return [...this.items.values()].map(item => item.value).sort((a, b) => this.key(a).localeCompare(this.key(b))); }
  get(id: string): T | undefined { return this.items.get(id)?.value; }
}

export class PluginJobRegistry extends ContributionRegistry<PluginJobDefinition> {
  constructor() { super(value => value.id, "job"); }
  async run(id: string, signal?: AbortSignal): Promise<void> { const job = this.get(id); if (!job) throw new Error(`plugin job not found: ${id}`); await job.run({ jobId: id, ...(signal ? { signal } : {}) }); }
}

export class PluginCommandRegistry extends ContributionRegistry<PluginCommandDefinition> {
  constructor() { super(value => value.name, "command"); }
  override register(pluginId: string, command: PluginCommandDefinition): void {
    const autocomplete = command.options?.filter(option => option.autocomplete) ?? [];
    if (autocomplete.some(option => option.type !== "string" || option.choices?.length)) throw new TypeError(`plugin command ${command.name} autocomplete requires a string option without static choices`);
    if (autocomplete.length > 0 && !command.autocomplete) throw new TypeError(`plugin command ${command.name} declares autocomplete without a handler`);
    super.register(pluginId, command);
  }
  async execute(name: string, input: JsonObject, context?: { readonly userId: string; readonly channelId?: string; readonly guildId?: string; readonly signal?: AbortSignal }): Promise<JsonObject> { const command = this.get(name); if (!command) throw new Error(`plugin command not found: ${name}`); return command.execute(input, context); }
  async complete(name: string, option: string, value: string, context?: { readonly userId: string; readonly channelId?: string; readonly guildId?: string; readonly signal?: AbortSignal }): Promise<readonly { readonly name: string; readonly value: string }[]> {
    const command = this.get(name); if (!command?.autocomplete) return [];
    const choices = await command.autocomplete(option, value, context);
    if (choices.length > 25 || choices.some(choice => !choice.name.trim() || choice.name.length > 100 || !choice.value.trim() || choice.value.length > 100)) throw new TypeError(`plugin command ${name} returned invalid autocomplete choices`);
    return choices;
  }
}

export class SkillRegistry extends ContributionRegistry<SkillDefinition> {
  constructor() { super(value => value.id, "skill"); }
}

export class SubagentProfileRegistry extends ContributionRegistry<SubagentProfileDefinition> {
  constructor() { super(value => value.id, "subagent profile"); }
}
