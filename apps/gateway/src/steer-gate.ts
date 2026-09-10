/** Serializes durable steer writes and provides an atomic final-delivery seal. */
export class SteerGate {
  private accepting = true;
  private tail: Promise<void> = Promise.resolve();

  submit(operation: () => Promise<void>): Promise<void> | undefined {
    if (!this.accepting) return undefined;
    const current = this.tail.then(operation);
    this.tail = current.catch(() => undefined);
    return current;
  }

  async flush(): Promise<void> { await this.tail; }

  async seal(): Promise<void> {
    this.accepting = false;
    await this.tail;
  }
}
