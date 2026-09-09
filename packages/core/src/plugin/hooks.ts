import type { JsonObject } from "../ports/json.js";
import { NOOP_LOGGER, type StructuredLogger } from "../observability/logger.js";

export interface PluginHookContext {
  readonly event: string;
  readonly pluginId: string;
  readonly signal?: AbortSignal;
}

export interface PluginHookDefinition {
  readonly id: string;
  readonly event: string;
  readonly handle: (payload: JsonObject, context: PluginHookContext) => Promise<void>;
}

interface RegisteredHook {
  readonly pluginId: string;
  readonly definition: PluginHookDefinition;
}

/** In-process event fan-out. A failing hook is isolated from other hooks and the emitter. */
export class PluginHookRegistry {
  private readonly hooks = new Map<string, RegisteredHook>();

  constructor(
    private readonly logger: StructuredLogger = NOOP_LOGGER,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  register(pluginId: string, hook: PluginHookDefinition): void {
    if (!/^[a-z][a-z0-9_.-]{0,127}$/.test(hook.id)) throw new TypeError(`invalid plugin hook id: ${hook.id}`);
    if (!/^[a-z][a-z0-9_.:-]{0,127}$/.test(hook.event)) throw new TypeError(`invalid plugin hook event: ${hook.event}`);
    if (this.hooks.has(hook.id)) throw new Error(`duplicate plugin hook registration: ${hook.id}`);
    this.hooks.set(hook.id, { pluginId, definition: hook });
  }

  unregister(hookId: string): boolean {
    return this.hooks.delete(hookId);
  }

  list(event?: string): readonly PluginHookDefinition[] {
    return [...this.hooks.values()]
      .filter(item => event === undefined || item.definition.event === event)
      .map(item => item.definition)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async emit(event: string, payload: JsonObject, signal?: AbortSignal): Promise<void> {
    const selected = [...this.hooks.values()].filter(item => item.definition.event === event);
    await Promise.all(selected.map(async ({ pluginId, definition }) => {
      try {
        await definition.handle(payload, { event, pluginId, ...(signal ? { signal } : {}) });
      } catch (error) {
        try {
          this.logger.write({
            level: "error",
            event: "plugin.hook.failed",
            message: "Plugin hook failed",
            occurredAt: this.now(),
            pluginId,
            data: {
              hookId: definition.id,
              hookEvent: event,
              errorName: error instanceof Error ? error.name : "NonErrorThrown",
            },
          });
        } catch {
          // A broken observer must not break hook failure isolation.
        }
      }
    }));
  }
}
