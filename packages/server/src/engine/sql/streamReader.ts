/**
 * Node.js Readable ストリームから固定サイズの行バッチを読み出すヘルパー。
 */
import { SQL_BATCH_SIZE } from './constants';

/** キュー上限の batchSize 倍率。 */
export const QUEUE_HIGH_WATER_MULTIPLIER = 2;

export interface RowStreamReaderOptions {
  /** 1 バッチあたりの行数(背圧の基準)。 */
  batchSize?: number;
  /** キュー上限 = batchSize * multiplier。 */
  queueHighWaterMultiplier?: number;
}

export class RowStreamReader {
  private readonly queue: unknown[][] = [];
  private done = false;
  private failed: unknown = null;
  private readonly waiters: Array<() => void> = [];
  private readonly stream: NodeJS.ReadableStream;
  private readonly highWaterMark: number;
  private paused = false;
  private disposed = false;

  private readonly onData = (row: unknown): void => {
    if (this.disposed) return;
    this.queue.push(Array.isArray(row) ? (row as unknown[]) : [row]);
    this.maybePause();
    this.signal();
  };

  private readonly onEnd = (): void => {
    this.done = true;
    this.signal();
  };

  private readonly onError = (err: unknown): void => {
    this.failed = err;
    this.signal();
  };

  constructor(stream: NodeJS.ReadableStream, options?: RowStreamReaderOptions) {
    const batch = options?.batchSize ?? SQL_BATCH_SIZE;
    const multiplier = options?.queueHighWaterMultiplier ?? QUEUE_HIGH_WATER_MULTIPLIER;
    this.highWaterMark = batch * multiplier;
    this.stream = stream;
    stream.on('data', this.onData);
    stream.on('end', this.onEnd);
    stream.on('error', this.onError);
  }

  /** キューに溜まっている行数(テスト・診断用)。 */
  queueDepth(): number {
    return this.queue.length;
  }

  /** 背圧で pause 中か。 */
  isPaused(): boolean {
    return this.paused;
  }

  /**
   * リスナ解除と pause 解除。接続返却・破棄前に呼ぶ。
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.done = true;
    this.stream.removeListener('data', this.onData);
    this.stream.removeListener('end', this.onEnd);
    this.stream.removeListener('error', this.onError);
    if (this.paused) {
      this.stream.resume?.();
      this.paused = false;
    }
    while (this.waiters.length > 0) {
      const w = this.waiters.shift();
      w?.();
    }
  }

  private maybePause(): void {
    if (!this.paused && this.queue.length >= this.highWaterMark) {
      this.stream.pause?.();
      this.paused = true;
    }
  }

  private maybeResume(): void {
    if (this.paused && this.queue.length < this.highWaterMark) {
      this.stream.resume?.();
      this.paused = false;
    }
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
      if (this.disposed && this.queue.length === 0) {
        return { rows: [], done: true };
      }
      if (this.queue.length > 0 || this.done) {
        const rows = this.queue.splice(0, max);
        this.maybeResume();
        const finished = this.done && this.queue.length === 0;
        return { rows, done: finished };
      }
      await new Promise<void>((resolve) => {
        if (this.disposed) {
          resolve();
          return;
        }
        this.waiters.push(resolve);
      });
    }
  }
}
