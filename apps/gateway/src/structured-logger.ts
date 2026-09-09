import type { LogRecord, StructuredLogger } from "@umiro/core";

export class JsonLineLogger implements StructuredLogger {
  constructor(private readonly writeLine: (line: string) => void = line => process.stderr.write(line)) {}

  write(record: LogRecord): void {
    this.writeLine(`${JSON.stringify(record)}\n`);
  }
}
