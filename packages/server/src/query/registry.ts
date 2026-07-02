/**
 * このファイルは `QueryExecution` インスタンスをメモリ上で管理する
 * `QueryRegistry` を提供する。
 *
 * 役割: クエリの提出（submit）を受け付けて `QueryExecution` を生成し、
 * 同時実行数（concurrency）をセマフォで制御しながら実行をスケジューリング
 * する。また、終端状態（finished/failed/canceled）に達したクエリを
 * TTL（ttlMs）経過後に定期的に掃除（sweep）してメモリを解放する。
 *
 * アーキテクチャ上の位置づけ: HTTP ルート層（担当外）は `QueryRegistry` を
 * 通じてクエリを提出し、`queryId` で `QueryExecution` を引く。実際の
 * ライフサイクル管理は execution.ts の `QueryExecution` に委譲し、この
 * クラスは「誰が、いつ、何件同時に実行できるか」という運用上の制御に専念
 * する。`service.ts`（履歴永続化）はこのレジストリをラップして構築される。
 */
import type { TrinoClient } from '../trino/client';
import type { TrinoRequestContext } from '../trino/types';
import { AppError } from '../errors';
import { newId } from '../util/id';
import { QueryExecution, type OverflowMode } from './execution';

/** `QueryRegistry` の生成に必要なオプション一式。 */
export interface QueryRegistryOptions {
  client: TrinoClient;
  /** Default cap on buffered rows per query. */
  // 1 クエリあたりバッファする行数のデフォルト上限。
  defaultMaxRows: number;
  /** Maximum concurrently-running queries. */
  // 同時に実行できるクエリの最大数（セマフォの容量）。
  concurrency: number;
  /** Retention for finished queries, in ms. */
  // 終了済みクエリをメモリ上に保持しておく期間（ミリ秒）。これを過ぎると
  // sweep() の対象になる。
  ttlMs: number;
  defaultOverflowMode: OverflowMode;
  /** Sweep interval in ms (default ttlMs/4, min 60s). Set 0 to disable timer. */
  // 定期掃除（sweep）を実行する間隔（ミリ秒）。未指定時は ttlMs/4（下限 60 秒）。
  // 0 を指定するとタイマー自体を無効化できる。
  sweepIntervalMs?: number;
  /** Wall-clock time source (injectable for tests). */
  // テストで時刻を差し替えられるようにするための注入ポイント。
  now?: () => number;
  /** Called when a query settles (for history bookkeeping). */
  // クエリが終端状態に達した際に呼ばれるフック（履歴の記録などに使う）。
  onSettled?: (exec: QueryExecution) => void;
}

/** `submit()` に渡すクエリ提出パラメータ。 */
export interface SubmitParams {
  statement: string;
  ctx: TrinoRequestContext;
  maxRows?: number;
  overflowMode?: OverflowMode;
}

/**
 * In-memory registry of query executions (design.md §3). Owns the concurrency
 * semaphore, the queued-waiters list, and the TTL sweep for finished queries.
 *
 * クエリ実行（`QueryExecution`）をメモリ上で管理するレジストリ
 * （design.md §3 参照）。同時実行数を制御するセマフォ、順番待ちの
 * キュー（waiters）、終了済みクエリを掃除する TTL スイープを保持する。
 */
export class QueryRegistry {
  // queryId をキーに実行中/終了済みの QueryExecution を保持するマップ。
  private readonly executions = new Map<string, QueryExecution>();
  private readonly client: TrinoClient;
  private readonly defaultMaxRows: number;
  private readonly concurrency: number;
  private readonly ttlMs: number;
  private readonly defaultOverflowMode: OverflowMode;
  private readonly now: () => number;
  private readonly onSettled?: (exec: QueryExecution) => void;

  // 現在実行中（スロットを保持中）のクエリ数。
  private running = 0;
  // 実行スロットの空きを待っているクエリの resolve コールバック一覧（FIFO）。
  private readonly waiters: Array<() => void> = [];
  // 終了済みクエリを定期的に掃除するタイマー。
  private sweepTimer?: ReturnType<typeof setInterval>;

  constructor(options: QueryRegistryOptions) {
    this.client = options.client;
    this.defaultMaxRows = options.defaultMaxRows;
    this.concurrency = options.concurrency;
    this.ttlMs = options.ttlMs;
    this.defaultOverflowMode = options.defaultOverflowMode;
    this.now = options.now ?? Date.now;
    this.onSettled = options.onSettled;

    // スイープ間隔が未指定なら ttlMs の 1/4（下限 60 秒）を採用する。
    const interval = options.sweepIntervalMs ?? Math.max(Math.floor(this.ttlMs / 4), 60_000);
    if (interval > 0 && this.ttlMs > 0) {
      this.sweepTimer = setInterval(() => this.sweep(), interval);
      // Don't keep the process alive solely for the sweep timer.
      // スイープ用タイマーだけのためにプロセスが終了できなくなるのを防ぐ
      // （unref によりイベントループの生存維持対象から外す）。
      this.sweepTimer.unref?.();
    }
  }

  /** Submit a new query. Returns immediately with the assigned execution. */
  // 新しいクエリを提出する。QueryExecution を即座に生成し登録して呼び出し元へ
  // 返し、実際の実行開始（run()）はセマフォの空きを待ってから非同期に行う
  // （scheduleRun を待たずに返るため、呼び出しはノンブロッキング）。
  submit(params: SubmitParams): QueryExecution {
    const queryId = newId('q_');
    const exec = new QueryExecution({
      queryId,
      statement: params.statement,
      ctx: params.ctx,
      maxRows: params.maxRows ?? this.defaultMaxRows,
      overflowMode: params.overflowMode ?? this.defaultOverflowMode,
      client: this.client,
      now: this.now,
      onSettled: (e) => {
        this.onSettled?.(e);
      },
    });
    this.executions.set(queryId, exec);
    // Schedule the run respecting the concurrency semaphore.
    // 同時実行数の制約を守りながら実行をスケジューリングする
    // （このメソッド自体は submit() の完了を待たせないよう fire-and-forget）。
    void this.scheduleRun(exec);
    return exec;
  }

  // 実行スロットを獲得してから exec.run() を実行し、完了後（成功したか失敗
  // したかを問わず）必ずスロットを解放する。
  private async scheduleRun(exec: QueryExecution): Promise<void> {
    await this.acquireSlot();
    try {
      // If it was canceled while queued, run() short-circuits to canceled.
      // スロット待ちの間にキャンセルされていた場合、run() は Trino への
      // リクエストを送らずに即座に canceled として終了する。
      await exec.run();
    } finally {
      this.releaseSlot();
    }
  }

  // 実行スロットを獲得する。空きがあれば同期的にカウントを増やして即解決、
  // 満杯であれば waiters キューに resolve コールバックを積んで待機する
  // （releaseSlot() が呼ばれた際に FIFO で解決される）。
  private acquireSlot(): Promise<void> {
    if (this.running < this.concurrency) {
      this.running += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.running += 1;
        resolve();
      });
    });
  }

  // 実行スロットを 1 つ解放する。待機中のクエリがあれば先頭（最も古い
  // 待機者）を 1 つ取り出して実行を許可する。
  private releaseSlot(): void {
    this.running -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }

  // queryId から QueryExecution を取得する（見つからなければ undefined）。
  get(queryId: string): QueryExecution | undefined {
    return this.executions.get(queryId);
  }

  // queryId から QueryExecution を取得する。見つからない場合は 404 相当の
  // AppError を送出する（HTTP ルート層が直接使うことを想定した便利メソッド）。
  getOrThrow(queryId: string): QueryExecution {
    const exec = this.executions.get(queryId);
    if (!exec) throw AppError.notFound(`Query ${queryId} not found`);
    return exec;
  }

  /** Remove finished executions older than the TTL. Returns count removed. */
  // 終端状態に達してから TTL（ttlMs）以上経過した実行をマップから削除する。
  // 削除件数を返す（テストや診断用）。ttlMs が 0 以下の場合は掃除自体を
  // 行わない（無制限保持）。
  sweep(): number {
    if (this.ttlMs <= 0) return 0;
    const cutoff = this.now() - this.ttlMs;
    let removed = 0;
    for (const [id, exec] of this.executions) {
      if (exec.isTerminal && exec.finishedAt !== undefined && exec.finishedAt <= cutoff) {
        this.executions.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  /** Number of currently tracked executions (for tests/diagnostics). */
  // 現在レジストリが保持している実行の総数（実行中か終了済みかを問わず）。
  size(): number {
    return this.executions.size;
  }

  /** Cancel all running queries and stop the sweep timer (shutdown). */
  // サーバーシャットダウン時の後始末: スイープタイマーを止め、まだ終端状態に
  // 達していない全クエリに対してキャンセルを要求し、全て完了するのを待つ。
  async shutdown(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    await Promise.all(
      [...this.executions.values()].filter((e) => !e.isTerminal).map((e) => e.requestCancel()),
    );
  }
}
