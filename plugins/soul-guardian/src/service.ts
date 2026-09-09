import { createHash } from "node:crypto";
import type { PluginStateStore } from "@umiro/core/plugin";
import type { SoulGuardianCheckResult, SoulGuardianConfig, SoulGuardianItem, SoulGuardianTarget } from "./types.js";
import { SoulGuardianWorkspace } from "./workspace-files.js";

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function statePath(prefix: string, target: string): string {
  return `${prefix}/${target}`;
}

export class SoulGuardianService {
  private readonly workspace: SoulGuardianWorkspace;
  private readonly targets: readonly SoulGuardianTarget[];

  constructor(config: SoulGuardianConfig, private readonly state: PluginStateStore) {
    this.workspace = new SoulGuardianWorkspace(config.workspacePath);
    const deduplicated = new Map<string, SoulGuardianTarget>();
    for (const target of config.targets) deduplicated.set(target.path, { ...target });
    this.targets = [...deduplicated.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  start(): Promise<void> {
    return this.workspace.start();
  }

  async status(): Promise<readonly SoulGuardianItem[]> {
    const items: SoulGuardianItem[] = [];
    for (const target of this.targets) {
      if (target.mode === "ignore") {
        items.push({ ...target, status: "ignored" });
        continue;
      }
      const [current, approved] = await Promise.all([
        this.workspace.read(target.path),
        this.state.read(statePath("approved", target.path)),
      ]);
      if (!current) {
        items.push({ ...target, status: "missing", ...(approved ? { approvedSha256: sha256(approved) } : {}) });
      } else if (!approved) {
        items.push({ ...target, status: "unapproved", currentSha256: sha256(current) });
      } else {
        const currentSha256 = sha256(current);
        const approvedSha256 = sha256(approved);
        items.push({
          ...target,
          status: currentSha256 === approvedSha256 ? "ok" : "drift",
          currentSha256,
          approvedSha256,
        });
      }
    }
    return items;
  }

  async approve(paths: readonly string[], approvedAt = new Date().toISOString()): Promise<readonly string[]> {
    const approved: string[] = [];
    for (const target of this.select(paths)) {
      const current = await this.workspace.read(target.path);
      if (!current) throw new Error(`cannot approve missing target: ${target.path}`);
      const key = statePath("approved", target.path);
      const previous = await this.state.read(key);
      if (previous) {
        const historyKey = statePath(`history/${approvedAt.replace(/[^0-9TZ]/g, "")}`, target.path);
        await this.state.writeAtomic(historyKey, previous);
      }
      await this.state.writeAtomic(key, current);
      approved.push(target.path);
    }
    return approved;
  }

  async restore(paths: readonly string[], quarantineAt = new Date().toISOString()): Promise<readonly string[]> {
    const restored: string[] = [];
    for (const target of this.select(paths)) {
      const approved = await this.state.read(statePath("approved", target.path));
      if (!approved) throw new Error(`cannot restore target without an approved snapshot: ${target.path}`);
      const current = await this.workspace.read(target.path);
      if (current) {
        const quarantineKey = statePath(`quarantine/${quarantineAt.replace(/[^0-9TZ]/g, "")}`, target.path);
        await this.state.writeAtomic(quarantineKey, current);
      }
      await this.workspace.writeAtomic(target.path, approved);
      restored.push(target.path);
    }
    return restored;
  }

  async check(noRestore = false): Promise<SoulGuardianCheckResult> {
    let items = await this.status();
    const toRestore = items.filter(item => item.status === "drift" && item.mode === "restore").map(item => item.path);
    const restored = noRestore || toRestore.length === 0 ? [] : await this.restore(toRestore);
    if (restored.length > 0) items = await this.status();
    const actionable = items.filter(item => item.status !== "ok" && item.status !== "ignored");
    const fingerprint = actionable.length === 0
      ? "clean"
      : sha256(Buffer.from(actionable.map(item => `${item.path}:${item.status}:${item.currentSha256 ?? ""}`).sort().join("\n"))).slice(0, 32);
    return { ok: actionable.length === 0, items, restored, fingerprint };
  }

  history(path: string) {
    this.select([path]);
    return this.state.list("history").then(entries => entries.filter(entry => entry.key.endsWith(`/${path}`)));
  }

  private select(paths: readonly string[]): readonly SoulGuardianTarget[] {
    const requested = new Set(paths);
    const selected = this.targets.filter(target => target.mode !== "ignore" && requested.has(target.path));
    if (selected.length !== requested.size) {
      const known = new Set(selected.map(target => target.path));
      const invalid = [...requested].filter(path => !known.has(path));
      throw new TypeError(`unknown or ignored Soul Guardian targets: ${invalid.join(", ")}`);
    }
    return selected;
  }
}
