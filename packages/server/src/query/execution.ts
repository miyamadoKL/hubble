/**
 * このファイルは Query Guard 実行基盤の中核である `QueryExecution` クラスを提供する。
 *
 * 役割: 1 つの SQL クエリ提出（submit）から終了（finished/failed/canceled）までの
 * ライフサイクル全体を管理する「実行インスタンス」。Trino の `/v1/statement`
 * プロトコル（POST で開始 → nextUri を GET でポーリング → 完了/失敗/DELETE で終了）
 * をラップし、以下を行う:
 *   - Trino から返る各ページ（columns/data/stats）を蓄積し、行バッファを構築する
 *   - バッファ上限（maxRows）到達時の overflow 制御（truncate/cancel）
 *   - ステート遷移（queued -> running -> finished|failed|canceled）を
 *     `QueryEvent` として購読者（SSE ハンドラなど）にファンアウトする
 *   - キャンセル要求（DELETE 相当）の受付と Trino への伝播
 *
 * アーキテクチャ上の位置づけ: `registry.ts`（同時実行数制御と TTL 掃除）が
 * `QueryExecution` を生成し管理し、`service.ts`（履歴永続化）や `sse.ts`
 * （SSE ストリーミング）、`csv.ts`（CSV ダウンロード）はこのクラスが持つ
 * バッファとイベントストリームを介して結果を取り出す。Trino との通信自体は
 * `../trino/client` の `TrinoClient` に委譲する。
 */
import type {
  ApiErrorDetail,
  QueryColumn,
  QueryEvent,
  QuerySnapshot,
  QueryState,
  QueryStats,
} from '@hubble/contracts';
import { AppError, toErrorResponse } from '../errors';
import type { TrinoClient } from '../trino/client';
import {
  emptySessionMutations,
  toQueryColumns,
  toQueryStats,
  type TrinoRequestContext,
  type TrinoSessionMutations,
} from '../trino/types';

// バッファが maxRows に到達したときの挙動: 'truncate' はそこで受信を打ち切って
// バッファするが Trino 側のクエリ自体は最後まで走らせる（rowCount は総数を反映）。
// 'cancel' はバッファが truncate された時点で Trino クエリ自体を DELETE で止める。
export type OverflowMode = 'truncate' | 'cancel';

// `QueryExecution` の生成に必要な初期値一式。呼び出し元（registry.ts）が
// 提出パラメータと依存（TrinoClient、時刻源）をまとめて渡す。
export interface QueryExecutionInit {
  queryId: string;
  statement: string;
  ctx: TrinoRequestContext;
  maxRows: number;
  overflowMode: OverflowMode;
  client: TrinoClient;
  /** Wall-clock time source (injectable for tests). */
  // テスト時に時刻を差し替えられるようにするための注入ポイント。
  now?: () => number;
  /** Called when the query reaches a terminal state. */
  // 終端状態（finished/failed/canceled）に達した瞬間に一度だけ呼ばれるフック。
  // registry/service 側の履歴更新などに使われる。
  onSettled?: (exec: QueryExecution) => void;
}

// SSE 配信などに使うイベントリスナーの型。emit() から同期的に呼び出される。
type Listener = (event: QueryEvent) => void;

/**
 * A single query's lifecycle and buffered result. Drives the Trino polling
 * loop, accumulates rows in an in-memory page store, and fans out SSE events
 * to subscribers. Terminal states: finished | failed | canceled.
 *
 * 1 件のクエリのライフサイクルと結果バッファを表すクラス。Trino のポーリング
 * ループを駆動し、受信した行をメモリ上のページストアに蓄積しつつ、購読者
 * （SSE ハンドラ等）へイベントをファンアウトする。終端状態は
 * finished | failed | canceled の 3 つ。
 */
export class QueryExecution {
  // 生成時に確定し、以降変化しない基本情報。
  readonly queryId: string;
  readonly statement: string;
  readonly ctx: TrinoRequestContext;
  readonly maxRows: number;
  readonly overflowMode: OverflowMode;
  readonly submittedAt: number;

  private readonly client: TrinoClient;
  private readonly now: () => number;
  private readonly onSettled?: (exec: QueryExecution) => void;

  // 可変のライフサイクル状態。state はステートマシンの現在地。
  state: QueryState = 'queued';
  trinoQueryId?: string;
  infoUri?: string;
  columns: QueryColumn[] = [];
  stats?: QueryStats;
  error?: ApiErrorDetail;
  finishedAt?: number;
  /** True once buffering stopped at `maxRows` while the query kept running. */
  // maxRows に達してバッファへの追加を打ち切った後に true になる。
  truncated = false;
  /** Session mutations to reflect on completion (set-catalog/schema/session). */
  // SET CATALOG/SCHEMA/SESSION などクエリ完了時に上位セッションへ反映すべき変更。
  readonly mutations: TrinoSessionMutations = emptySessionMutations();

  /** Buffered rows (capped at maxRows when overflowMode === 'truncate'). */
  // 実際にメモリへ保持している行データ本体。
  private readonly rows: unknown[][] = [];
  /** Total rows produced by Trino (may exceed buffered count when truncated). */
  // Trino が実際に生成した総行数。truncate 時はバッファ件数より大きくなり得る。
  private producedRows = 0;

  // イベント購読者集合（SSE 接続ごとに subscribe される）。
  private readonly listeners = new Set<Listener>();
  // Trino へのポーリング/開始リクエストを中断させるための AbortController。
  private readonly abort = new AbortController();
  /** The latest nextUri, used for DELETE cancellation. */
  // 直近取得した nextUri。キャンセル時にこの URI へ DELETE を投げる。
  private currentNextUri?: string;
  // requestCancel() が呼ばれたことを示すフラグ。run() のループ各所でチェックされる。
  private cancelRequested = false;
  /** Resolves when the execution reaches a terminal state. */
  // settled Promise を解決するための resolve 関数（コンストラクタ内で束縛）。
  private settledResolve!: () => void;
  readonly settled: Promise<void>;

  constructor(init: QueryExecutionInit) {
    this.queryId = init.queryId;
    this.statement = init.statement;
    this.ctx = init.ctx;
    this.maxRows = init.maxRows;
    this.overflowMode = init.overflowMode;
    this.client = init.client;
    this.now = init.now ?? Date.now;
    this.onSettled = init.onSettled;
    this.submittedAt = this.now();
    // settled は run() が終端状態に到達した時点で resolve される。
    // 呼び出し元（service.ts など）は `await exec.settled` で完了を待てる。
    this.settled = new Promise((resolve) => {
      this.settledResolve = resolve;
    });
  }

  // Trino が生成した総行数（バッファされたかどうかを問わない）。
  get rowCount(): number {
    return this.producedRows;
  }

  // 実際にメモリバッファへ保持している行数。
  get bufferedCount(): number {
    return this.rows.length;
  }

  // 終端状態（これ以上ステートが変化しない）かどうか。
  get isTerminal(): boolean {
    return this.state === 'finished' || this.state === 'failed' || this.state === 'canceled';
  }

  /** Read a page of buffered rows. */
  // ページング API（/rows エンドポイント用）。offset を 0 未満から補正してから
  // slice する。範囲外アクセスでも例外にはならず空配列/短い配列を返す。
  getRows(offset: number, limit: number): unknown[][] {
    if (offset < 0) offset = 0;
    return this.rows.slice(offset, offset + limit);
  }

  /** Iterate buffered rows (for CSV streaming). Index-based so concurrent
   * appends during an in-flight query are picked up. */
  // インデックス指定で 1 行だけ取り出す。CSV ストリーミング（csv.ts）が
  // クエリ実行中でも増え続けるバッファを追随して読めるようにするための API。
  rowAt(index: number): unknown[] | undefined {
    return this.rows[index];
  }

  // イベント購読を開始し、解除用の unsubscribe 関数を返す。
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // 全購読者へイベントを同期的に配信する。
  private emit(event: QueryEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        // A failing listener must not break the loop or other listeners.
        // 1 つのリスナーが例外を投げても、他の購読者への配信やループ自体は継続する。
      }
    }
  }

  // 現時点の状態を API レスポンス用のスナップショット（QuerySnapshot）へ変換する。
  // 未設定のフィールド（trinoQueryId/infoUri/stats/columns/error/finishedAt）は
  // 存在する場合のみ出力し、JSON を不要に肥大化させない。
  snapshot(): QuerySnapshot {
    const snap: QuerySnapshot = {
      queryId: this.queryId,
      state: this.state,
      rowCount: this.producedRows,
      truncated: this.truncated,
      submittedAt: new Date(this.submittedAt).toISOString(),
    };
    if (this.trinoQueryId) snap.trinoQueryId = this.trinoQueryId;
    if (this.infoUri) snap.infoUri = this.infoUri;
    if (this.stats) snap.stats = this.stats;
    if (this.columns.length > 0) snap.columns = this.columns;
    if (this.error) snap.error = this.error;
    if (this.finishedAt) snap.finishedAt = new Date(this.finishedAt).toISOString();
    return snap;
  }

  /** Snapshot of all already-buffered rows, for SSE replay. */
  // SSE 新規接続時のリプレイ（sse.ts の buildReplayEvents）用に、現在のバッファを
  // 丸ごとコピーして返す（以降の追加行の影響を受けないスナップショット）。
  bufferedRows(): unknown[][] {
    return this.rows.slice();
  }

  // state を更新し、変化があった場合のみ 'state' イベントを発火する
  // （同一状態への再設定は無視して冗長なイベントを防ぐ）。
  private setState(state: QueryState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit({ type: 'state', state });
  }

  // 列定義を一度だけ確定させる。すでに列がある場合や空配列の場合は無視する
  // （Trino は最初のデータページでのみ columns を返すため、以後のページでは
  // 上書きしない）。
  private setColumns(columns: QueryColumn[]): void {
    if (columns.length === 0 || this.columns.length > 0) return;
    this.columns = columns;
    this.emit({ type: 'columns', columns });
  }

  // 受信した行データをバッファへ追記する。まず producedRows（総生成数）を
  // 加算し、その後バッファ残容量（maxRows - 現在のバッファ長）に応じて
  // 受け入れる行数を決める。残容量を超えるページを受け取った場合は
  // truncated フラグを立てる。実際にバッファへ追加した分だけ 'rows' イベントを
  // 発火する（切り詰められた分はイベントに含めない）。
  private appendRows(data: unknown[][]): void {
    if (data.length === 0) return;
    this.producedRows += data.length;
    const remaining = this.maxRows - this.rows.length;
    if (remaining <= 0) {
      this.truncated = true;
      return;
    }
    const accepted = data.length <= remaining ? data : data.slice(0, remaining);
    const offset = this.rows.length;
    for (const row of accepted) this.rows.push(row);
    if (accepted.length < data.length) this.truncated = true;
    this.emit({ type: 'rows', offset, rows: accepted });
  }

  // 最新の統計情報（stats）を更新し、'stats' イベントを発火する。
  private setStats(stats: QueryStats): void {
    this.stats = stats;
    this.emit({ type: 'stats', stats });
  }

  /** Request cancellation. Safe to call before, during, or after the run. */
  // キャンセル要求。run() の開始前/実行中/実行後いずれのタイミングで呼ばれても
  // 安全なように設計されている。すでに終端状態なら何もしない。
  async requestCancel(): Promise<void> {
    if (this.isTerminal) return;
    this.cancelRequested = true;
    // Trino への開始/ポーリングリクエストを中断させる。
    this.abort.abort();
    // すでに nextUri を持っている（Trino 側にクエリが存在する）場合は
    // 明示的に DELETE を送ってサーバー側のクエリも止める。
    if (this.currentNextUri) {
      await this.client.cancel(this.currentNextUri, this.ctx);
    }
  }

  /**
   * Drive the polling loop to completion. Resolves (never rejects) when the
   * query reaches a terminal state; failures are recorded as `error` + state.
   *
   * クエリのライフサイクル全体を駆動するメインループ。POST で開始し、
   * nextUri がある限り GET でポーリングを続け、終端状態に達したら settle() で
   * 終了処理を行う。例外を投げることはなく（reject しない）、失敗は
   * error フィールドと state='failed' として記録される。
   */
  async run(): Promise<void> {
    try {
      // キューイング中にキャンセルされていた場合は Trino へリクエストすら
      // 送らずに即座に canceled として終了する。
      if (this.cancelRequested) {
        this.settle('canceled', { code: 'CANCELED', message: 'Query canceled before start' });
        return;
      }
      const signal = this.abort.signal;
      // クエリを開始（POST /v1/statement 相当）。最初のページを受け取る。
      let page = await this.client.start(this.statement, this.ctx, this.mutations, signal);
      this.trinoQueryId = page.id;
      if (page.infoUri) this.infoUri = page.infoUri;
      this.setState('running');
      this.applyPage(page);

      // Backoff discipline (Trino client protocol): when a page carries data,
      // fetch the next page with zero delay and reset the counter. Only escalate
      // the backoff while data-less pages (queued/planning/empty) repeat, so a
      // streaming result is never throttled to ~1 page/sec.
      // バックオフ規律（Trino クライアントプロトコル）: ページにデータが
      // 含まれていれば待機なしで即座に次ページを取得し、カウンタをリセットする。
      // データなしページ（queued/planning/空）が連続するときだけバックオフを
      // 段階的に増やす。これにより、データが流れている間はスループットが
      // 「1 ページ/秒」程度に絞られてしまうことがない。
      let idleAttempt = 0;
      while (page.nextUri) {
        this.currentNextUri = page.nextUri;
        // ループ中の各ステップでキャンセル要求をチェックし、要求があれば
        // Trino 側のクエリを DELETE してから canceled として終了する。
        if (this.cancelRequested) {
          await this.client.cancel(page.nextUri, this.ctx);
          this.settle('canceled', { code: 'CANCELED', message: 'Query canceled' });
          return;
        }
        // overflowMode==='cancel' で既にバッファが truncate 済みなら、
        // これ以上結果を受け取る必要がないため Trino クエリを止めて
        // finished として終了する（cancel だが結果としては成功扱い）。
        if (this.overflowMode === 'cancel' && this.truncated) {
          await this.client.cancel(page.nextUri, this.ctx);
          this.settle('finished');
          return;
        }
        const hadData = pageHasData(page);
        if (hadData) {
          // データを含むページを受け取った直後は待たずに次を取りに行く。
          idleAttempt = 0;
        } else {
          // データなしページが続く間は、client 側のバックオフ関数に従い
          // 徐々に待機時間を延ばす（idleAttempt をインクリメント）。
          await this.client.waitBackoff(idleAttempt, signal);
          idleAttempt += 1;
        }
        if (this.cancelRequested) {
          await this.client.cancel(page.nextUri, this.ctx);
          this.settle('canceled', { code: 'CANCELED', message: 'Query canceled' });
          return;
        }
        // 次ページを取得（GET nextUri 相当）し、結果をバッファへ適用する。
        page = await this.client.advance(page.nextUri, this.ctx, this.mutations, signal);
        this.applyPage(page);
      }
      // nextUri が無くなった = Trino 側でクエリが完了した、という合図。
      this.currentNextUri = undefined;
      this.settle('finished');
    } catch (err) {
      // 例外発生時、直前にキャンセルが要求されていればそれを優先して
      // canceled として扱う（Abort による例外を失敗と誤認しないため）。
      if (this.cancelRequested) {
        this.settle('canceled', { code: 'CANCELED', message: 'Query canceled' });
        return;
      }
      const { detail } = toErrorResponse(err);
      // A structured Trino/user error is a query failure; transport faults too.
      // 構造化された Trino/ユーザーエラーもトランスポート層の障害も、
      // ここでは同様に failed として扱う。
      const state: QueryState = err instanceof AppError && err.status >= 500 ? 'failed' : 'failed';
      this.settle(state, detail);
    }
  }

  // Trino から受け取った 1 ページ分の内容（columns/data/stats）を、
  // 存在するフィールドだけ状態へ反映する。
  private applyPage(page: Awaited<ReturnType<TrinoClient['start']>>): void {
    if (page.columns) this.setColumns(toQueryColumns(page.columns));
    if (page.data) this.appendRows(page.data);
    if (page.stats) this.setStats(toQueryStats(page.stats));
  }

  // 終端状態への遷移を一度だけ行う共通処理。finishedAt の記録、エラーの設定、
  // state 遷移イベント、error イベント（エラーがある場合）、done イベントの
  // 発火、そして settled Promise の解決と onSettled フックの呼び出しを
  // この順序で行う。isTerminal な状態から再度呼ばれても何もしない
  // （二重終了を防ぐガード）。
  private settle(state: QueryState, error?: ApiErrorDetail): void {
    if (this.isTerminal) return;
    this.finishedAt = this.now();
    if (error) this.error = error;
    this.setState(state);
    if (error) this.emit({ type: 'error', error });
    this.emit({ type: 'done', state, rowCount: this.producedRows, truncated: this.truncated });
    this.settledResolve();
    this.onSettled?.(this);
  }
}

/** True when a Trino page carried result rows. */
// ページが実際に結果行を含んでいたかどうかを判定するヘルパー。
// バックオフのリセット/継続判定に使われる。
function pageHasData(page: { data?: unknown[][] }): boolean {
  return page.data !== undefined && page.data.length > 0;
}
