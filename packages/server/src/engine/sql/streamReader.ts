/**
 * Node.js Readable ストリームから固定サイズの行バッチを読み出すヘルパー。
 */
export class RowStreamReader {
  private readonly queue: unknown[][] = [];
  private done = false;
  private failed: unknown = null;
  private readonly waiters: Array<() => void> = [];

  constructor(stream: NodeJS.ReadableStream) {
    stream.on('data', (row: unknown) => {
      this.queue.push(Array.isArray(row) ? (row as unknown[]) : [row]);
      this.signal();
    });
    stream.on('end', () => {
      this.done = true;
      this.signal();
    });
    stream.on('error', (err) => {
      this.failed = err;
      this.signal();
    });
  }

  private signal(): void {
    const w = this.waiters.shift();
    if (w) w();
  }

  /**
   * 最大 max 行を読み出す。ストリーム終端に達したら done=true。
   * @param max - 読み出す最大行数。
   */
  async readBatch(max: number): Promise<{ rows: unknown[][]; done: boolean }> {
    for (;;) {
      if (this.failed) throw this.failed;
      if (this.queue.length > 0 || this.done) {
        const rows = this.queue.splice(0, max);
        const finished = this.done && this.queue.length === 0;
        return { rows, done: finished };
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}