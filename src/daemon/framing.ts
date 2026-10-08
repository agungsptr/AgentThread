/** Splits a byte stream into newline-terminated UTF-8 lines without breaking multi-byte characters. */
export class LineReader {
  private buf = Buffer.alloc(0);

  push(chunk: Uint8Array): string[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const lines: string[] = [];
    let i: number;
    while ((i = this.buf.indexOf(10)) >= 0) {
      lines.push(this.buf.subarray(0, i).toString("utf8"));
      this.buf = this.buf.subarray(i + 1);
    }
    return lines;
  }
}

/** Queues JSON lines and flushes them across partial socket writes. Call flush() from the drain handler. */
export class LineWriter {
  private out = Buffer.alloc(0);

  constructor(private readonly write: (bytes: Uint8Array) => number) {}

  send(value: unknown): void {
    this.out = Buffer.concat([this.out, Buffer.from(`${JSON.stringify(value)}\n`)]);
    this.flush();
  }

  flush(): void {
    while (this.out.length) {
      const n = this.write(this.out);
      if (n <= 0) return;
      this.out = this.out.subarray(n);
    }
  }
}
