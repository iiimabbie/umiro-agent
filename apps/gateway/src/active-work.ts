export interface ActiveWorkDrainResult {
  readonly drained: boolean;
  readonly cancelled: number;
}

async function settlesWithin(tasks: readonly Promise<unknown>[], timeoutMs: number): Promise<boolean> {
  if (!tasks.length) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.allSettled(tasks).then(() => true),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); timer.unref?.(); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Tracks adapter callbacks so shutdown can stop ingress before closing
 * durability services that those callbacks may still be using. */
export class ActiveWorkTracker {
  private readonly tasks = new Set<Promise<unknown>>();

  track<T>(work: Promise<T>): Promise<T> {
    let tracked!: Promise<T>;
    tracked = work.finally(() => { this.tasks.delete(tracked); });
    this.tasks.add(tracked);
    return tracked;
  }

  get size(): number { return this.tasks.size; }

  async drain(options: { readonly timeoutMs: number; readonly cancellationGraceMs: number; readonly cancel: () => number }): Promise<ActiveWorkDrainResult> {
    const initial = [...this.tasks];
    if (await settlesWithin(initial, options.timeoutMs)) return { drained: true, cancelled: 0 };
    const cancelled = options.cancel();
    const drained = await settlesWithin([...this.tasks], options.cancellationGraceMs);
    return { drained, cancelled };
  }
}
