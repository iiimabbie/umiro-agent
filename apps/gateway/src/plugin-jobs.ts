import { Cron, type CronOptions } from "croner";
import type { PluginHost } from "@umiro/core/plugin";

export class PluginJobScheduler {
  private readonly active = new Map<string, Cron>();
  constructor(private readonly host: PluginHost, private readonly options: CronOptions = {}) {}

  start(): void {
    for (const job of this.host.listJobs()) {
      if (this.active.has(job.id)) throw new Error(`plugin job already scheduled: ${job.id}`);
      const task = new Cron(job.schedule, this.options, () => void this.host.runJob(job.id).catch(error => {
        process.stderr.write(`plugin job ${job.id} failed: ${error instanceof Error ? error.message : String(error)}\n`);
      }));
      this.active.set(job.id, task);
    }
  }

  stop(): void { for (const task of this.active.values()) task.stop(); this.active.clear(); }
  list(): readonly string[] { return [...this.active.keys()].sort(); }
}
