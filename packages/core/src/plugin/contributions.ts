import type { JsonObject } from "../ports/json.js";
import type { PluginCommandDefinition, PluginControlPanelDocument, PluginControlPanelDocumentSummary, PluginControlPanelViewDefinition, PluginJobDefinition, SkillDefinition, SubagentProfileDefinition } from "./contract.js";

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

export interface PluginControlPanelViewMetadata {
  readonly pluginId: string;
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly kind: "markdown-collection";
  readonly writable: boolean;
}

const CONTROL_PANEL_ID = /^[A-Za-z0-9._:-]{1,160}$/;
const MAX_CONTROL_PANEL_LIST = 5_000;
const MAX_CONTROL_PANEL_TEXT = 100_000;

function validateId(value: unknown, label: string): string {
  if (typeof value !== "string" || !CONTROL_PANEL_ID.test(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function validateTitle(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const title = value.trim();
  if (!title || title.length > 200) throw new TypeError(`${label} is invalid`);
  return title;
}

function validateOccurredAt(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new TypeError(`${label} is invalid`);
  return value;
}

function validateSummary(value: unknown, index: number): PluginControlPanelDocumentSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`plugin control panel document ${index} is invalid`);
  const item = value as Record<string, unknown>;
  const id = validateId(item.id, `plugin control panel document ${index} id`);
  const title = validateTitle(item.title, `plugin control panel document ${index} title`);
  const occurredAt = validateOccurredAt(item.occurredAt, `plugin control panel document ${index} occurredAt`);
  return { id, title, ...(occurredAt ? { occurredAt } : {}) };
}

function validateDocument(value: unknown, requestedId: string): PluginControlPanelDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("plugin control panel document is invalid");
  const item = value as Record<string, unknown>;
  const id = validateId(item.id, "plugin control panel document id");
  if (id !== requestedId) throw new TypeError("plugin control panel document id does not match request");
  const title = validateTitle(item.title, "plugin control panel document title");
  if (typeof item.content !== "string" || item.content.length > MAX_CONTROL_PANEL_TEXT) throw new TypeError("plugin control panel document content is invalid");
  const occurredAt = validateOccurredAt(item.occurredAt, "plugin control panel document occurredAt");
  return { id, title, content: item.content, ...(occurredAt ? { occurredAt } : {}) };
}

export class PluginControlPanelViewRegistry {
  private readonly items = new Map<string, { pluginId: string; value: PluginControlPanelViewDefinition }>();
  register(pluginId: string, value: PluginControlPanelViewDefinition): void {
    const id = validateId(value?.id, "plugin control panel view id");
    if (value?.kind !== "markdown-collection") throw new TypeError(`plugin control panel view ${id} has an unsupported kind`);
    if (value.writable !== true && value.update) throw new TypeError(`plugin control panel view ${id} has an update handler without writable capability`);
    if (value.writable === true && typeof value.update !== "function") throw new TypeError(`plugin control panel view ${id} declares writable capability without an update handler`);
    const title = validateTitle(value.title, `plugin control panel view ${id} title`);
    if (value.description !== undefined && (typeof value.description !== "string" || value.description.length > 1_000)) throw new TypeError(`plugin control panel view ${id} description is invalid`);
    if (this.items.has(id)) throw new Error(`duplicate plugin control panel view: ${id}`);
    this.items.set(id, { pluginId, value: { ...value, id, title, writable: value.writable === true, ...(value.description !== undefined ? { description: value.description } : {}) } });
  }
  unregister(id: string): boolean { return this.items.delete(id); }
  list(): readonly PluginControlPanelViewMetadata[] { return [...this.items.entries()].map(([id, item]) => ({ pluginId: item.pluginId, id, title: item.value.title, ...(item.value.description !== undefined ? { description: item.value.description } : {}), kind: item.value.kind, writable: item.value.writable === true })).sort((a, b) => a.id.localeCompare(b.id)); }
  private get(id: string): { pluginId: string; value: PluginControlPanelViewDefinition } | undefined { return this.items.get(id); }
  async listDocuments(viewId: string): Promise<readonly PluginControlPanelDocumentSummary[]> {
    validateId(viewId, "plugin control panel view id");
    const item = this.get(viewId); if (!item) throw new Error(`plugin control panel view not found: ${viewId}`);
    const values = await item.value.list();
    if (!Array.isArray(values) || values.length > MAX_CONTROL_PANEL_LIST) throw new TypeError(`plugin control panel view ${viewId} returned too many documents`);
    const result = values.map((value, index) => validateSummary(value, index));
    if (new Set(result.map(value => value.id)).size !== result.length) throw new TypeError(`plugin control panel view ${viewId} returned duplicate document IDs`);
    return result;
  }
  async readDocument(viewId: string, documentId: string): Promise<PluginControlPanelDocument | undefined> {
    validateId(viewId, "plugin control panel view id"); validateId(documentId, "plugin control panel document id");
    const item = this.get(viewId); if (!item) throw new Error(`plugin control panel view not found: ${viewId}`);
    const value = await item.value.read(documentId);
    return value === undefined ? undefined : validateDocument(value, documentId);
  }
  async updateDocument(viewId: string, documentId: string, content: string): Promise<PluginControlPanelDocument | undefined> {
    validateId(viewId, "plugin control panel view id"); validateId(documentId, "plugin control panel document id");
    if (typeof content !== "string" || content.length > MAX_CONTROL_PANEL_TEXT) throw new TypeError("plugin control panel document content is invalid");
    const item = this.get(viewId); if (!item) throw new Error(`plugin control panel view not found: ${viewId}`);
    if (item.value.writable !== true || !item.value.update) throw new Error(`plugin control panel view is read-only: ${viewId}`);
    const value = await item.value.update(documentId, content);
    return value === undefined ? undefined : validateDocument(value, documentId);
  }
}
