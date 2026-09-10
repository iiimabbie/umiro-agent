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
  async execute(name: string, input: JsonObject, context?: { readonly userId: string; readonly channelId?: string; readonly guildId?: string; readonly signal?: AbortSignal }): Promise<JsonObject> { const command = this.get(name); if (!command) throw new Error(`plugin command not found: ${name}`); return command.execute(input, context); }
}

export class SkillRegistry extends ContributionRegistry<SkillDefinition> {
  constructor() { super(value => value.id, "skill"); }
}

export class SubagentProfileRegistry extends ContributionRegistry<SubagentProfileDefinition> {
  constructor() { super(value => value.id, "subagent profile"); }
}
