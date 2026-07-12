/**
 * Hono の SSE stream と、失敗を呼び出し元へ返す strict writer を接続する。
 */
import type { SSEStreamingApi } from 'hono/streaming';

/** strict SSE bridge の生成オプション。 */
export interface StrictSseBridgeOptions {
  onFailure?: (error: unknown) => void;
}

type PipeOutcome = { ok: true } | { ok: false; error: unknown };

/**
 * Hono の `write()` が握りつぶす writer rejection を、別の TransformStream を
 * `pipe()` することで呼び出し元へ伝える。
 */
export class StrictSseBridge {
  private readonly encoder = new TextEncoder();
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly pipeOutcome: Promise<PipeOutcome>;
  private readonly onFailure: (error: unknown) => void;
  private finalizing?: Promise<void>;
  private suppressFailure = false;
  private failureNotified = false;

  /** bridge の writable が正常終了または失敗するまで待つ。 */
  readonly closed: Promise<void>;

  constructor(stream: SSEStreamingApi, options: StrictSseBridgeOptions = {}) {
    this.onFailure = options.onFailure ?? (() => undefined);
    const bridge = new TransformStream<Uint8Array, Uint8Array>();
    this.writer = bridge.writable.getWriter();
    this.closed = this.writer.closed;

    // pipe Promise には生成直後に rejection handler を付け、未処理 rejection を防ぐ。
    this.pipeOutcome = stream.pipe(bridge.readable).then(
      () => ({ ok: true }),
      (error: unknown) => {
        this.notifyFailure(error);
        return { ok: false, error };
      },
    );
    void this.closed.catch((error: unknown) => {
      this.notifyFailure(error);
    });
  }

  /** SSE frame を backpressure 付きで書き、失敗を reject として返す。 */
  async write(frame: string): Promise<void> {
    await this.writer.write(this.encoder.encode(frame));
  }

  /** writable を閉じてから、Hono 側への pipe 完了を待つ。 */
  close(): Promise<void> {
    this.finalizing ??= this.closeOnce();
    return this.finalizing;
  }

  /** writable を中断し、pipe の rejection まで回収する。 */
  async abort(reason: unknown = new Error('SSE bridge aborted')): Promise<void> {
    if (this.finalizing) {
      await this.finalizing.catch(() => undefined);
      return;
    }
    this.suppressFailure = true;
    this.finalizing = this.abortOnce(reason);
    await this.finalizing;
  }

  private async closeOnce(): Promise<void> {
    let closeError: unknown;
    try {
      await this.writer.close();
    } catch (error) {
      closeError = error;
      this.notifyFailure(error);
    }
    const outcome = await this.pipeOutcome;
    if (!outcome.ok) throw outcome.error;
    if (closeError !== undefined) throw closeError;
  }

  private async abortOnce(reason: unknown): Promise<void> {
    await this.writer.abort(reason).catch(() => undefined);
    await this.pipeOutcome;
  }

  private notifyFailure(error: unknown): void {
    if (this.suppressFailure || this.failureNotified) return;
    this.failureNotified = true;
    try {
      this.onFailure(error);
    } catch (callbackError) {
      console.error('strict SSE bridge failure callback failed', callbackError);
    }
  }
}
