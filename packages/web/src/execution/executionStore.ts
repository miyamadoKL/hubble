// Execution store ("状態" + 実行フロー). One zustand store keyed
// by cellId. Each cell holds its current query's id/state/stats/columns/rows and
// the SSE subscription that feeds them. A monotonically increasing generation
// per cell lets a stale subscription's events be dropped the instant a newer run
// (or cancel) supersedes it — no torn state when a user re-runs quickly.
//
// Row data lives only here (server memory + SSE). The structure is
// reconstructible from a snapshot + rows page, so a reload can call
// `restoreCell` to resume a still-running query by re-subscribing.
//
// This module owns *no* React; components read it through the hooks at the end.
//
// ── 日本語補足 ──
// セル実行の状態管理を担う zustand ストア（本ファイルが execution レイヤーの中核）。
// セル ID をキーに、実行中/直近に実行したクエリの state、stats、columns、rows と、
// それを購読する SSE サブスクリプションを 1 レコードにまとめて保持する。セルごとに
// 単調増加する世代 (generation) カウンタを持ち、再実行やキャンセルで古い購読からの
// イベントを即座に無視できるようにしている（連打しても状態が壊れない）。
// 行データはこのストア（メモリ）と SSE のみに存在し、DB には結果の要約のみが残る。
// 構造はスナップショット + 行ページから再構築可能なため、リロード後
// も `restoreCell` で実行中クエリへ再購読して復元できる。
// このモジュール自体は React 非依存で、末尾のセレクタフック経由でのみ Component から
// 参照される。

import { create } from 'zustand';
import type {
  ApiErrorDetail,
  QueryColumn,
  QuerySnapshot,
  QueryState,
  QueryStats,
} from '@hubble/contracts';
import { createQuery, cancelQuery, fetchQuerySnapshot, fetchQueryRows } from './api';
import {
  SseProtocolError,
  subscribeQueryEvents,
  type EventSourceFactory,
  type SseSubscription,
} from './sse';
import { withAutoLimit } from './sql';
import type { ExecutionUnit } from './executionUnit';

/**
 * A row is an array of cells; values are JSON scalars or null.
 * 1 行分のデータ。各セルの値は JSON スカラー値または null。
 */
export type ResultRow = ReadonlyArray<unknown>;

/**
 * Per-cell execution record. `idle` cells have no entry at all.
 * セルごとの実行レコード。実行したことのない（idle な）セルはエントリ自体を持たない。
 */
export interface CellExecution {
  /**
   * Server-assigned query id (stable across reconnects).
   * サーバー採番のクエリ ID（再接続をまたいでも不変）。
   */
  queryId: string;
  /** Trino 側の実際のクエリ ID（Trino Web UI へのリンクなどに使用）。 */
  trinoQueryId?: string;
  /** Trino Web UI への直リンク URL。 */
  infoUri?: string;
  /** クエリの現在の実行状態（queued/running/finished/failed/canceled など）。 */
  state: QueryState;
  /** 進捗とスキャン量などの統計情報（SSE の stats イベントで更新）。 */
  stats?: QueryStats;
  /** 結果の列定義。columns イベントで確定する。 */
  columns: QueryColumn[];
  /** クライアント側に取り込み済みの結果行。 */
  rows: ResultRow[];
  /** rowsをin-place更新した回数。参照が同じでもconsumerへ変更を通知する。 */
  rowsVersion: number;
  /**
   * Total rows the server reports buffered (may exceed `rows.length` mid-stream).
   * サーバーが保持中の総行数（ストリーム途中は `rows.length` を上回りうる）。
   */
  rowCount: number;
  /** クエリ失敗時のエラー詳細。 */
  error?: ApiErrorDetail;
  /**
   * True when the server capped the result at maxRows (snapshot.truncated).
   * サーバーが maxRows で結果を打ち切った場合に true。
   */
  truncated: boolean;
  /**
   * True when a truncated CSV download may re-execute the statement for full results.
   * 打ち切り時に全文 CSV の再実行が可能か（サーバー snapshot/done 由来）。
   */
  csvReexecAllowed: boolean;
  /** 実行開始時刻（ミリ秒エポック）。経過時間の算出に使う。 */
  startedAt: number;
  /** 終了時刻（ミリ秒エポック）。未終了なら undefined。 */
  finishedAt?: number;
  /**
   * The exact statement text sent to the server (post auto-LIMIT).
   * 実際にサーバーへ送信したステートメント全文（auto-LIMIT 適用後）。
   */
  statement: string;
  /**
   * The unit's offset span in the source, for mapping error line/col back.
   * エラー行/列をセル全体のソースへ逆写像するための、実行単位の開始オフセット。
   */
  unitStart: number;
  /**
   * When running >1 statement, which index this is and the total.
   * 複数ステートメントを順次実行中の場合の、現在のインデックスと総数。
   */
  batchIndex?: number;
  batchTotal?: number;
}

/**
 * Context forwarded to the server with each query.
 * クエリ発行のたびにサーバーへ渡す実行コンテキスト（カタログ/スキーマ/紐づく notebook）。
 */
export interface ExecutionContext {
  catalog?: string;
  schema?: string;
  notebookId?: string;
  /** 実行先データソース id。省略時はサーバー既定。 */
  datasourceId?: string;
}

/**
 * Options controlling a run (auto-LIMIT toggle + value).
 * 実行時のオプション（auto-LIMIT の有効/無効と、その上限値）。
 */
export interface RunOptions {
  autoLimit: boolean;
  limit: number;
}

// zustand ストアの外側に置くセル単位のランタイム状態（購読ハンドルや世代番号）。
// これらは描画に関与しないため、set/get 経由の reactive な state には入れない
// （購読の張り替えや解除のたびに再レンダーが走るのを避けるため）。
interface CellRuntime {
  /**
   * The active generation; events from older generations are ignored.
   * 現在有効な世代番号。これより古い世代からのイベントは無視される。
   */
  generation: number;
  /** 現在張っている SSE 購読（未実行/購読解除済みなら undefined）。 */
  subscription?: SseSubscription;
  /**
   * Resolves when the current run reaches a terminal state (for batches).
   * 現在の実行が終端状態に達したら resolve される Promise のハンドル
   * （バッチ実行の逐次待ち合わせ用）。
   */
  settle?: { resolve: (state: QueryState) => void };
  /** 現在のバッチを次の文へ進めないための停止要求。 */
  cancelRequested?: boolean;
}

// ストアが公開する state + action の型。cells が唯一の reactive state で、
// あとはすべて cells を操作するための action。
interface ExecutionStoreState {
  cells: Record<string, CellExecution>;
  /**
   * Run one unit on a cell, replacing any prior result.
   * セルで 1 実行単位を実行し、既存の結果を置き換える。
   */
  runUnit: (cellId: string, unit: ExecutionUnit, ctx: ExecutionContext, opts: RunOptions) => void;
  /**
   * Run units sequentially, stopping at the first failure (Hue-compatible).
   * 複数の実行単位を順番に実行し、最初の失敗で停止する（Hue 互換の挙動）。
   */
  runUnits: (
    cellId: string,
    units: ExecutionUnit[],
    ctx: ExecutionContext,
    opts: RunOptions,
  ) => Promise<void>;
  /**
   * Cancel the cell's running query (propagates DELETE to the server).
   * セルの実行中クエリをキャンセルする（サーバーへ DELETE を伝播）。
   */
  cancel: (cellId: string) => Promise<void>;
  /**
   * Drop a cell's result entirely (clears the result pane).
   * セルの結果を完全に破棄する（結果ペインをクリア）。
   */
  clear: (cellId: string) => void;
  /**
   * Re-subscribe to a known query (reload/reconnect restore).
   * 既知のクエリ ID へ再購読する（リロード/再接続時の復元用）。
   */
  restoreCell: (cellId: string, queryId: string) => Promise<void>;
}

// Per-cell runtime (subscriptions, generation) is kept outside the reactive
// store so subscribing/unsubscribing never triggers a render.
// セル単位のランタイム（購読や世代）を保持する Map。zustand の外に置くことで
// 購読の開始/停止が再レンダーを引き起こさないようにしている。
const runtimes = new Map<string, CellRuntime>();

/**
 * EventSource factory — overridable in tests via `__setEventSourceFactory`.
 * EventSource の生成関数。テストでは `__setEventSourceFactory` でモックに差し替える。
 */
let eventSourceFactory: EventSourceFactory | undefined;
/** テスト用フック: EventSource ファクトリを差し替える（本番コードでは呼ばない）。 */
export function __setEventSourceFactory(factory: EventSourceFactory | undefined): void {
  eventSourceFactory = factory;
}

/**
 * Summary of a settled execution, written back into the notebook (resultMeta).
 * 実行が終端状態に達したときのサマリー。notebook 側（cell.resultMeta）へ永続化される。
 */
export interface CellResultSummary {
  trinoQueryId?: string;
  state: QueryState;
  rowCount: number;
  columnCount: number;
  elapsedMs: number;
  errorMessage?: string;
  finishedAt: string;
}

/**
 * Sink invoked when a cell's run reaches a terminal state, so a higher layer can
 * persist a lightweight summary into `cell.resultMeta` (結果の要約
 * のみ永続化). Injected to keep the execution store free of the notebook store
 * (no import cycle); a no-op until wired by `__setCellSettledSink`.
 */
let cellSettledSink: ((cellId: string, summary: CellResultSummary) => void) | undefined;
/** テスト/本番配線用フック: セル終了時のサマリー送出先（notebook ストア）を差し替える。 */
export function __setCellSettledSink(
  sink: ((cellId: string, summary: CellResultSummary) => void) | undefined,
): void {
  cellSettledSink = sink;
}

/**
 * Build + emit the result summary for a settled cell (idempotent enough).
 * 終端状態に達したセルからサマリーを組み立て、シンクへ送出する
 * （複数回呼ばれても実害はない）。
 */
function emitCellSettled(cellId: string, cell: CellExecution): void {
  if (!cellSettledSink) return; // シンク未配線（テスト等）なら何もしない
  cellSettledSink(cellId, {
    trinoQueryId: cell.trinoQueryId,
    state: cell.state,
    rowCount: cell.rowCount,
    columnCount: cell.columns.length,
    // stats に elapsedTimeMillis があればそれを優先し、無ければ開始/終了時刻の差で代用する。
    elapsedMs: cell.stats?.elapsedTimeMillis ?? (cell.finishedAt ?? Date.now()) - cell.startedAt,
    errorMessage: cell.error?.message,
    finishedAt: new Date(cell.finishedAt ?? Date.now()).toISOString(),
  });
}

/** セルのランタイムを取得し、未作成なら世代 0 で新規作成する（遅延初期化）。 */
function runtimeFor(cellId: string): CellRuntime {
  let rt = runtimes.get(cellId);
  if (!rt) {
    rt = { generation: 0 };
    runtimes.set(cellId, rt);
  }
  return rt;
}

/**
 * Tear down a cell's active subscription (no state change).
 * セルの現在の SSE 購読を閉じるだけの処理（cells の state 自体は変更しない）。
 */
function teardown(cellId: string): void {
  const rt = runtimes.get(cellId);
  if (rt?.subscription) {
    rt.subscription.close();
    rt.subscription = undefined;
  }
}

// 終端状態の集合。この集合に含まれる state なら、そのクエリはもう進行しない。
const TERMINAL: ReadonlySet<QueryState> = new Set(['finished', 'failed', 'canceled']);

export const useExecutionStore = create<ExecutionStoreState>((set, get) => {
  /**
   * Patch a cell's execution record (only if it still belongs to `generation`).
   * セルの実行レコードを部分更新する。ただし呼び出し時点の世代が現在の世代と一致
   * する場合のみ反映する。一致しなければ「古い（既に上書きされた）イベント」と
   * みなして無視する。これが再実行連打やキャンセルで状態が壊れないための要。
   */
  const patch = (
    cellId: string,
    generation: number,
    updater: (prev: CellExecution) => CellExecution,
  ) => {
    if (runtimeFor(cellId).generation !== generation) return; // stale event
    const prev = get().cells[cellId];
    if (!prev) return;
    set((s) => ({ cells: { ...s.cells, [cellId]: updater(prev) } }));
  };

  /** 現世代のセルを1回だけ終端し、購読解除とbatch待機の解決をそろえて行う。 */
  const settleTerminal = (
    cellId: string,
    generation: number,
    updater: (current: CellExecution) => CellExecution,
    options: { advanceGeneration?: boolean; closeSubscription?: boolean } = {},
  ): boolean => {
    const rt = runtimeFor(cellId);
    if (rt.generation !== generation) return false;
    const current = get().cells[cellId];
    if (!current) return false;
    const terminal = updater(current);
    if (options.advanceGeneration) rt.generation += 1;
    if (options.closeSubscription) teardown(cellId);
    else rt.subscription = undefined;
    set((state) => ({ cells: { ...state.cells, [cellId]: terminal } }));
    emitCellSettled(cellId, terminal);
    rt.settle?.resolve(terminal.state);
    rt.settle = undefined;
    return true;
  };

  /**
   * Subscribe to a query and route events into the cell record.
   * クエリの SSE イベントを購読し、種類ごとにセルレコードへ反映するディスパッチャ。
   */
  const subscribe = (cellId: string, queryId: string, generation: number) => {
    const rt = runtimeFor(cellId);
    rt.subscription = subscribeQueryEvents(
      queryId,
      {
        onEvent: (event) => {
          switch (event.type) {
            case 'state':
              // state イベント: queued/running/finished 等の実行状態が変わった。
              patch(cellId, generation, (prev) => ({ ...prev, state: event.state }));
              break;
            case 'columns':
              // columns イベント: 結果の列定義が確定した（通常は実行の早い段階で一度だけ）。
              patch(cellId, generation, (prev) => ({ ...prev, columns: event.columns }));
              break;
            case 'rows':
              patch(cellId, generation, (prev) => {
                // Append from the chunk's offset; tolerate replay overlap.
                // チャンクの offset 位置から行を書き込む。再接続時のリプレイで
                // 同じ offset が再送されても、上書きするだけなので重複しない。
                const rows = prev.rows;
                for (let i = 0; i < event.rows.length; i++) {
                  rows[event.offset + i] = event.rows[i]!;
                }
                return {
                  ...prev,
                  rows,
                  rowsVersion: prev.rowsVersion + 1,
                  rowCount: Math.max(prev.rowCount, rows.length),
                };
              });
              break;
            case 'stats':
              // stats イベント: 進捗/スキャン量などの統計が更新された。
              patch(cellId, generation, (prev) => ({ ...prev, stats: event.stats }));
              break;
            case 'error':
              // error イベント: クエリがエラーで終わる直前に、エラー詳細が送られてくる。
              patch(cellId, generation, (prev) => ({ ...prev, error: event.error }));
              break;
            case 'done':
              // done イベント: ストリームの終端。最終 state/rowCount/truncated を反映し、
              // 終了時刻を記録する。
              settleTerminal(cellId, generation, (prev) => ({
                ...prev,
                state: event.state,
                rowCount: Math.max(prev.rowCount, event.rowCount),
                truncated: event.truncated,
                csvReexecAllowed: event.csvReexecAllowed ?? false,
                finishedAt: Date.now(),
                error: prev.error?.code === 'CANCEL_FAILED' ? undefined : prev.error,
              }));
              break;
          }
        },
        onError: (error) => {
          if (error instanceof SseProtocolError) {
            const current = get().cells[cellId];
            // 契約違反後は進捗を復元できないため、孤児クエリを残さない方を優先して停止要求を送る。
            // ローリングデプロイ中の短い契約差で健全なクエリを止める可能性は許容する。
            if (current?.queryId) void cancelQuery(current.queryId).catch(() => undefined);
            settleTerminal(
              cellId,
              generation,
              (prev) => ({
                ...prev,
                state: 'failed',
                finishedAt: Date.now(),
                error: { code: 'SSE_PROTOCOL_ERROR', message: error.message },
              }),
              { closeSubscription: true },
            );
            return;
          }
          // Transport dropped before `done`. Leave the last-known state intact;
          // a restore() can resume. We don't mark failed — the query may still
          // be running server-side.
          // 通信が `done` の前に切れたケース。最後に分かっている state はそのまま
          // にしておき、failed 扱いにはしない（サーバー側ではまだ実行中の可能性が
          // あるため）。再開は restoreCell に任せる。
        },
      },
      eventSourceFactory,
    );
  };

  /** 現世代が未終端の場合だけcanceledへ遷移させる。 */
  const settleCanceled = (cellId: string, generation: number, error?: ApiErrorDetail): void => {
    const rt = runtimeFor(cellId);
    if (rt.generation !== generation) return;
    const current = get().cells[cellId];
    if (!current || TERMINAL.has(current.state)) return;
    settleTerminal(
      cellId,
      generation,
      (prev) => ({
        ...prev,
        state: 'canceled',
        finishedAt: Date.now(),
        error: error ?? (prev.error?.code === 'CANCEL_FAILED' ? undefined : prev.error),
      }),
      { advanceGeneration: true, closeSubscription: true },
    );
  };

  // 1 つの実行単位を実際にサーバーへ投げる中核関数。runUnit/runUnits の両方から
  // 呼ばれる。楽観的に 'queued' 状態のレコードを先に作ってから createQuery を
  // 発行し、成功したら SSE 購読を開始、失敗したら即座に failed で終端させる。
  const startQuery = (
    cellId: string,
    statement: string,
    unitStart: number,
    ctx: ExecutionContext,
    batch?: { index: number; total: number },
  ): Promise<QueryState> => {
    // Bump the generation: any in-flight subscription for this cell is now stale.
    // 世代をインクリメントする: これでこのセルの進行中の購読は全て「古い」ものになる。
    const rt = runtimeFor(cellId);
    rt.cancelRequested = false;
    teardown(cellId);
    const generation = ++rt.generation;

    // 終端状態に達したら resolve される Promise。runUnits の逐次実行が
    // 「1 つ前の文が終わるまで待つ」ために使う。
    const settled = new Promise<QueryState>((resolve) => {
      rt.settle = { resolve };
    });

    const record: CellExecution = {
      queryId: '',
      state: 'queued',
      columns: [],
      rows: [],
      rowsVersion: 0,
      rowCount: 0,
      truncated: false,
      csvReexecAllowed: false,
      startedAt: Date.now(),
      statement,
      unitStart,
      batchIndex: batch?.index,
      batchTotal: batch?.total,
    };
    set((s) => ({ cells: { ...s.cells, [cellId]: record } }));

    // クエリ発行。成功すれば queryId が確定するので SSE 購読を開始し、
    // 失敗すれば（バリデーションエラーや Query Guard の 422 ブロックなど）
    // その場でセルを failed 終端にする。
    createQuery({
      statement,
      catalog: ctx.catalog,
      schema: ctx.schema,
      notebookId: ctx.notebookId,
      cellId,
      datasourceId: ctx.datasourceId,
    })
      .then(({ queryId }) => {
        if (runtimeFor(cellId).generation !== generation) {
          // queryId確定前に取り消された実行も、作成完了後にサーバーへ停止要求を送る。
          void cancelQuery(queryId).catch(() => undefined);
          return;
        }
        patch(cellId, generation, (prev) => ({ ...prev, queryId }));
        subscribe(cellId, queryId, generation);
      })
      .catch((err: unknown) => {
        settleTerminal(cellId, generation, (prev) => ({
          ...prev,
          state: 'failed',
          finishedAt: Date.now(),
          error: toErrorDetail(err),
        }));
      });

    return settled;
  };

  return {
    cells: {},

    // 単発実行: auto-LIMIT を必要なら適用してから startQuery に渡すだけ。
    // 戻り値の Promise は待たない（fire-and-forget、UI は state の変化で追う）。
    runUnit: (cellId, unit, ctx, opts) => {
      const statement = opts.autoLimit ? withAutoLimit(unit.text, opts.limit).sql : unit.text;
      void startQuery(cellId, statement, unit.start, ctx);
    },

    // 複数ステートメントの逐次実行（「全セル実行」やセル内の複数文実行）。
    // 各文の終端状態を待ってから次へ進み、finished 以外（failed/canceled）で
    // 打ち切る（Hue 互換の「エラーで停止」挙動）。
    runUnits: async (cellId, units, ctx, opts) => {
      if (units.length === 0) return;
      for (let i = 0; i < units.length; i++) {
        const unit = units[i]!;
        const statement = opts.autoLimit ? withAutoLimit(unit.text, opts.limit).sql : unit.text;
        const finalState = await startQuery(cellId, statement, unit.start, ctx, {
          index: i,
          total: units.length,
        });
        if (runtimeFor(cellId).cancelRequested) break;
        // Hue-compatible: stop the batch at the first non-success terminal state.
        if (finalState !== 'finished') break;
      }
    },

    // DELETE が成功してから購読を閉じ、canceled を確定する。
    // 失敗時は購読を残し、サーバー側で継続するクエリのイベントを受け取る。
    cancel: async (cellId) => {
      const rt = runtimeFor(cellId);
      const cell = get().cells[cellId];
      if (!cell) return;
      if (TERMINAL.has(cell.state)) return;
      rt.cancelRequested = true;
      const generation = rt.generation;
      if (!cell.queryId) {
        // queryId確定前の応答を現世代へ反映しないよう、先に世代を進める。
        settleCanceled(cellId, generation);
        return;
      }
      try {
        await cancelQuery(cell.queryId);
      } catch (err) {
        if (err instanceof TypeError) {
          settleCanceled(cellId, generation, offlineCancelError());
          return;
        }
        patch(cellId, generation, (prev) =>
          TERMINAL.has(prev.state) ? prev : { ...prev, error: toCancelErrorDetail(err) },
        );
        throw err;
      }
      // 応答待ちの間に再実行された場合は、新しい世代を変更しない。
      if (rt.generation !== generation) return;
      settleCanceled(cellId, generation);
    },

    // 結果ペインのクリア。世代を進めて購読を閉じたうえで、cells からエントリ
    // そのものを削除する（idle 状態へ戻す）。
    clear: (cellId) => {
      const rt = runtimeFor(cellId);
      rt.generation++;
      teardown(cellId);
      rt.settle = undefined;
      set((s) => {
        const next = { ...s.cells };
        delete next[cellId];
        return { cells: next };
      });
    },

    // リロード/再接続時の復元。既知の queryId からスナップショット + 行ページを
    // 取得してセルを再構築し、まだ実行中なら SSE に再購読して続きを受け取る。
    restoreCell: async (cellId, queryId) => {
      const rt = runtimeFor(cellId);
      teardown(cellId);
      const generation = ++rt.generation;
      let snapshot: QuerySnapshot;
      try {
        snapshot = await fetchQuerySnapshot(queryId);
      } catch {
        return; // query gone (TTL-swept) — nothing to restore
      }
      if (runtimeFor(cellId).generation !== generation) return;

      const rows: ResultRow[] = [];
      try {
        // Pull whatever is buffered so far in one page.
        // その時点でサーバー側に溜まっている行を 1 ページで丸ごと取得する。
        const page = await fetchQueryRows(queryId, 0, Math.max(snapshot.rowCount, 1));
        rows.push(...page.rows);
      } catch {
        // ignore — rows may still arrive over SSE
      }
      if (runtimeFor(cellId).generation !== generation) return;

      const record: CellExecution = {
        queryId,
        trinoQueryId: snapshot.trinoQueryId,
        infoUri: snapshot.infoUri,
        state: snapshot.state,
        stats: snapshot.stats,
        columns: snapshot.columns ?? [],
        rows,
        rowsVersion: 0,
        rowCount: snapshot.rowCount,
        error: snapshot.error,
        truncated: snapshot.truncated,
        csvReexecAllowed: snapshot.csvReexecAllowed ?? false,
        startedAt: Date.parse(snapshot.submittedAt) || Date.now(),
        finishedAt: snapshot.finishedAt ? Date.parse(snapshot.finishedAt) : undefined,
        statement: '',
        unitStart: 0,
      };
      set((s) => ({ cells: { ...s.cells, [cellId]: record } }));

      // If still in flight, re-subscribe for the rest (SSE replays from start).
      // まだ終端状態でなければ、続きを受け取るために SSE へ再購読する
      // （サーバー側は接続のたびに現在状態を最初からリプレイする）。
      if (!TERMINAL.has(snapshot.state)) {
        subscribe(cellId, queryId, generation);
      }
    },
  };
});

/**
 * Normalise a thrown value into the contract error shape.
 * createQuery が投げた値（fetch エラーやコントラクトのエラー詳細）を、
 * 表示用の ApiErrorDetail 形式へ正規化する。
 */
function toErrorDetail(err: unknown): ApiErrorDetail {
  if (err && typeof err === 'object' && 'detail' in err) {
    const detail = (err as { detail: unknown }).detail;
    if (detail && typeof detail === 'object' && 'message' in detail) {
      return detail as ApiErrorDetail;
    }
  }
  return {
    code: 'EXECUTION_ERROR',
    message: err instanceof Error ? err.message : 'Failed to start the query',
  };
}

/** キャンセル要求の失敗を、実行中の状態を保ったまま表示する詳細へ変換する。 */
function toCancelErrorDetail(err: unknown): ApiErrorDetail {
  const detail = toErrorDetail(err);
  return { ...detail, code: 'CANCEL_FAILED' };
}

/** サーバー不達時にローカルだけで停止したことを明示する。 */
function offlineCancelError(): ApiErrorDetail {
  return {
    code: 'CANCEL_OFFLINE',
    message:
      'Canceled locally because the server could not be reached. The server-side query may still be running.',
  };
}

// ---- Selector hooks ---------------------------------------------------------
// ここから下は React コンポーネントが使うための薄いフック層。

/**
 * The execution record for a cell, or undefined when idle.
 * セルの実行レコード。idle（未実行）なら undefined。
 */
export function useCellExecution(cellId: string): CellExecution | undefined {
  return useExecutionStore((s) => s.cells[cellId]);
}

/** コンポーネントに公開する action の部分型（cells state 自体は含めない）。 */
export type ExecutionActions = Pick<
  ExecutionStoreState,
  'runUnit' | 'runUnits' | 'cancel' | 'clear' | 'restoreCell'
>;

/**
 * Stable action handles. The action closures are created once when the store is
 * built and never change identity, so reading them straight from `getState`
 * gives a referentially-stable object without subscribing to re-renders.
 * 安定した action ハンドル群を返す。action のクロージャはストア構築時に一度だけ
 * 作られ以後同一性が変わらないため、`getState` から直接読んでも参照的に安定した
 * オブジェクトが得られ、再レンダーの購読を発生させない。
 */
export function executionActions(): ExecutionActions {
  const s = useExecutionStore.getState();
  return {
    runUnit: s.runUnit,
    runUnits: s.runUnits,
    cancel: s.cancel,
    clear: s.clear,
    restoreCell: s.restoreCell,
  };
}

/**
 * True while the cell's query is queued or running.
 * セルのクエリが queued または running の間 true（実行中かどうかの判定）。
 */
export function isCellRunning(cell: CellExecution | undefined): boolean {
  return cell?.state === 'queued' || cell?.state === 'running';
}
