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
import type { TrinoRequestContext } from '../trino/types';
import type { QueryEngine } from '../engine/types';
import { AppError } from '../errors';
import { newId } from '../util/id';
import { QueryExecution, type OverflowMode, type QueryResultObserver } from './execution';

/** `QueryRegistry` の生成に必要なオプション一式。 */
export interface QueryRegistryOptions {
  /** データソース id から QueryEngine を引くマップ。 */
  engines: Map<string, QueryEngine>;
  /** datasourceId 省略時に使う既定 id。 */
  defaultDatasourceId: string;
  /** Default cap on buffered rows per query. */
  // 1 クエリあたりバッファする行数のデフォルト上限。
  defaultMaxRows: number;
  /** Maximum concurrently-running queries. */
  // 同時に実行できるクエリの最大数（セマフォの容量）。
  concurrency: number;
  /** 実行枠を待つクエリの全体上限。 */
  maxQueued: number;
  /** 同一 principal が実行枠を待つクエリの上限。 */
  maxQueuedPerPrincipal: number;
  /** 終端済みを含む registry 保持件数の上限。 */
  maxTracked: number;
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
  /** 実行先データソース id。省略時は defaultDatasourceId。 */
  datasourceId?: string;
  /** ユーザークエリかスケジュール実行か。 */
  executionSource?: 'user' | 'scheduled';
  /** principal が query.write を持たないとき true（MySQL/PG セッション防御）。 */
  sessionReadOnly?: boolean;
  /** RBAC 解決後の role 名。SQL データソースの credential 選択に使う。 */
  roleName?: string;
  maxRows?: number;
  overflowMode?: OverflowMode;
  /** queryId 採番後に結果 observer を生成する。 */
  makeResultObserver?: (queryId: string) => QueryResultObserver | undefined;
  /** queue 上限を数える principal。省略時は ctx.user を使う。 */
  queuePrincipal?: string;
}

interface QueryWaiter {
  exec: QueryExecution;
  principal: string;
  active: boolean;
  resolve: (acquired: boolean) => void;
}

/** QueryRegistry shutdown の入力。 */
export interface QueryRegistryShutdownOptions {
  deadlineAt?: number;
}

/** deadline までに全 execution が終端したかを返す。 */
export interface QueryRegistryShutdownResult {
  timedOut: boolean;
}

/**
 * In-memory registry of query executions. Owns the concurrency
 * semaphore, the queued-waiters list, and the TTL sweep for finished queries.
 *
 * クエリ実行（`QueryExecution`）をメモリ上で管理するレジストリ。
 * 同時実行数を制御するセマフォ、順番待ちの
 * キュー（waiters）、終了済みクエリを掃除する TTL スイープを保持する。
 */
export class QueryRegistry {
  // queryId をキーに実行中/終了済みの QueryExecution を保持するマップ。
  private readonly executions = new Map<string, QueryExecution>();
  private readonly engineLeaseReleases = new Map<string, () => void>();
  private readonly engines: Map<string, QueryEngine>;
  private defaultDatasourceId: string;
  private readonly defaultMaxRows: number;
  private readonly concurrency: number;
  private readonly maxQueued: number;
  private readonly maxQueuedPerPrincipal: number;
  private readonly maxTracked: number;
  private readonly ttlMs: number;
  private readonly defaultOverflowMode: OverflowMode;
  private readonly now: () => number;
  private readonly onSettled?: (exec: QueryExecution) => void;

  // 現在実行中（スロットを保持中）のクエリ数。
  private running = 0;
  // 実行スロットの空きを待っているクエリの resolve コールバック一覧（FIFO）。
  // 実行スロットの空きを待つクエリと principal を保持する FIFO。
  private readonly waiters: QueryWaiter[] = [];
  private readonly queuedByPrincipal = new Map<string, number>();
  private accepting = true;
  // 終了済みクエリを定期的に掃除するタイマー。
  private sweepTimer?: ReturnType<typeof setInterval>;
  private shutdownPromise?: Promise<QueryRegistryShutdownResult>;

  constructor(options: QueryRegistryOptions) {
    this.engines = options.engines;
    this.defaultDatasourceId = options.defaultDatasourceId;
    this.defaultMaxRows = options.defaultMaxRows;
    this.concurrency = options.concurrency;
    this.maxQueued = options.maxQueued;
    this.maxQueuedPerPrincipal = options.maxQueuedPerPrincipal;
    this.maxTracked = options.maxTracked;
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
    if (!this.accepting) {
      throw new AppError(503, {
        code: 'QUERY_SHUTTING_DOWN',
        message: 'Query admission is closed',
      });
    }
    const datasourceId = params.datasourceId ?? this.defaultDatasourceId;
    const engine = this.engines.get(datasourceId);
    if (!engine) {
      throw AppError.notFound(`Datasource ${datasourceId} not found`);
    }
    this.assertTrackedCapacity();
    const principal = params.queuePrincipal ?? params.ctx.user ?? 'technical';
    if (this.running >= this.concurrency) this.assertQueueCapacity(principal);

    const queryId = newId('q_');
    const execSource = params.executionSource ?? 'user';
    const releaseLease = engine.lease?.() ?? (() => {});
    this.engineLeaseReleases.set(queryId, releaseLease);
    let exec: QueryExecution;
    try {
      const client = engine.executionClient({
        source: execSource,
        user: params.ctx.user,
        roleName: params.roleName,
        sessionReadOnly: params.sessionReadOnly,
      });

      exec = new QueryExecution({
        queryId,
        statement: params.statement,
        ctx: params.ctx,
        datasourceId,
        maxRows: params.maxRows ?? this.defaultMaxRows,
        overflowMode: params.overflowMode ?? this.defaultOverflowMode,
        client,
        engine,
        now: this.now,
        makeResultObserver: params.makeResultObserver
          ? () => params.makeResultObserver?.(queryId)
          : undefined,
        onSettled: (e) => {
          this.releaseEngineLease(queryId);
          this.onSettled?.(e);
        },
      });
    } catch (err) {
      this.releaseEngineLease(queryId);
      throw err;
    }
    this.executions.set(queryId, exec);
    // Schedule the run respecting the concurrency semaphore.
    // 同時実行数の制約を守りながら実行をスケジューリングする
    // （このメソッド自体は submit() の完了を待たせないよう fire-and-forget）。
    void this.scheduleRun(exec, principal);
    return exec;
  }

  // 実行スロットを獲得してから exec.run() を実行し、完了後（成功したか失敗
  // したかを問わず）必ずスロットを解放する。
  private async scheduleRun(exec: QueryExecution, principal: string): Promise<void> {
    const acquired = await this.acquireSlot(exec, principal);
    if (!acquired) {
      this.releaseEngineLease(exec.queryId);
      return;
    }
    try {
      // If it was canceled while queued, run() short-circuits to canceled.
      // スロット待ちの間にキャンセルされていた場合、run() は Trino への
      // リクエストを送らずに即座に canceled として終了する。
      await exec.run();
    } finally {
      this.releaseSlot();
      // observer 例外で onSettled が呼ばれない場合も lease を回収する。
      this.releaseEngineLease(exec.queryId);
    }
  }

  private releaseEngineLease(queryId: string): void {
    const release = this.engineLeaseReleases.get(queryId);
    if (!release) return;
    this.engineLeaseReleases.delete(queryId);
    release();
  }

  // 実行スロットを獲得する。空きがあれば同期的にカウントを増やして即解決、
  // 満杯であれば waiters キューに resolve コールバックを積んで待機する
  // （releaseSlot() が呼ばれた際に FIFO で解決される）。
  private acquireSlot(exec: QueryExecution, principal: string): Promise<boolean> {
    if (this.running < this.concurrency) {
      this.running += 1;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const waiter: QueryWaiter = { exec, principal, active: true, resolve };
      this.waiters.push(waiter);
      this.incrementPrincipalQueue(principal);
      void exec.settled.then(() => this.cancelWaiter(waiter));
    });
  }

  // 実行スロットを 1 つ解放する。待機中のクエリがあれば先頭（最も古い
  // 待機者）を 1 つ取り出して実行を許可する。
  private releaseSlot(): void {
    this.running -= 1;
    const next = this.waiters.shift();
    if (!next) return;
    next.active = false;
    this.decrementPrincipalQueue(next.principal);
    this.running += 1;
    next.resolve(true);
  }

  private cancelWaiter(waiter: QueryWaiter): void {
    if (!waiter.active) return;
    waiter.active = false;
    const index = this.waiters.indexOf(waiter);
    if (index >= 0) this.waiters.splice(index, 1);
    this.decrementPrincipalQueue(waiter.principal);
    waiter.resolve(false);
  }

  private incrementPrincipalQueue(principal: string): void {
    this.queuedByPrincipal.set(principal, (this.queuedByPrincipal.get(principal) ?? 0) + 1);
  }

  private decrementPrincipalQueue(principal: string): void {
    const count = this.queuedByPrincipal.get(principal) ?? 0;
    if (count <= 1) this.queuedByPrincipal.delete(principal);
    else this.queuedByPrincipal.set(principal, count - 1);
  }

  private assertQueueCapacity(principal: string): void {
    if (this.waiters.length >= this.maxQueued) {
      throw new AppError(429, {
        code: 'QUERY_QUEUE_FULL',
        message: 'The query queue is full',
      });
    }
    if ((this.queuedByPrincipal.get(principal) ?? 0) >= this.maxQueuedPerPrincipal) {
      throw new AppError(429, {
        code: 'QUERY_PRINCIPAL_QUEUE_FULL',
        message: 'The query queue limit for this principal has been reached',
      });
    }
  }

  private assertTrackedCapacity(): void {
    if (this.executions.size < this.maxTracked) return;
    this.sweep();
    if (this.executions.size >= this.maxTracked) {
      throw new AppError(429, {
        code: 'QUERY_REGISTRY_FULL',
        message: 'The query registry is full',
      });
    }
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

  /** 実行枠待ちの件数。 */
  queuedCount(): number {
    return this.waiters.length;
  }

  /** 新しい query submit を同期的に拒否する。 */
  stopAccepting(): void {
    this.accepting = false;
  }

  setDefaultDatasourceId(id: string): void {
    this.defaultDatasourceId = id;
  }

  /** 保持中の全 QueryExecution を返す（管理 API 用）。 */
  listAll(): QueryExecution[] {
    return [...this.executions.values()];
  }

  /** Cancel all running queries and stop the sweep timer (shutdown). */
  // サーバーシャットダウン時の後始末: スイープタイマーを止め、まだ終端状態に
  // 達していない全クエリに対してキャンセルを要求し、全て完了するのを待つ。
  // 達していない全クエリへキャンセルを要求し、deadline まで終端を待つ。
  shutdown(options: QueryRegistryShutdownOptions = {}): Promise<QueryRegistryShutdownResult> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.runShutdown(options.deadlineAt ?? Number.POSITIVE_INFINITY);
    return this.shutdownPromise;
  }

  private async runShutdown(deadlineAt: number): Promise<QueryRegistryShutdownResult> {
    this.stopAccepting();
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    const active = [...this.executions.values()].filter((execution) => !execution.isTerminal);
    const canceled = Promise.allSettled(active.map((execution) => execution.requestCancel()));
    if (!(await settleBefore(canceled, deadlineAt))) return { timedOut: true };
    const settled = Promise.allSettled(active.map((execution) => execution.settled));
    return { timedOut: !(await settleBefore(settled, deadlineAt)) };
  }
}

async function settleBefore(promise: Promise<unknown>, deadlineAt: number): Promise<boolean> {
  if (!Number.isFinite(deadlineAt)) {
    await promise;
    return true;
  }
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), remainingMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
