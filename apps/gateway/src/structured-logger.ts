import type { LogRecord, StructuredLogger } from "@umiro/core";

export class JsonLineLogger implements StructuredLogger {
  private readonly records: LogRecord[] = [];
  constructor(private readonly writeLine: (line: string) => void = line => process.stderr.write(line), private readonly capacity = 500) {}

  write(record: LogRecord): void {
    this.records.push(structuredClone(record));
    if (this.records.length > this.capacity) this.records.splice(0, this.records.length - this.capacity);
    this.writeLine(`${JSON.stringify(record)}\n`);
  }

  list(limit = 100): readonly LogRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.capacity) throw new TypeError(`log limit must be between 1 and ${this.capacity}`);
    return structuredClone(this.records.slice(-limit).reverse());
  }
}
