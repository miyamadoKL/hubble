// Execution store (design.md §3 "状態" + §5 実行フロー). One zustand store keyed
// by cellId. Each cell holds its current query's id/state/stats/columns/rows and
// the SSE subscription that feeds them. A monotonically increasing generation
// per cell lets a stale subscription's events be dropped the instant a newer run
// (or cancel) supersedes it — no torn state when a user re-runs quickly.
//
// Row data lives only here (server memory + SSE; design.md §4). The structure is
// reconstructible from a snapshot + rows page, so a reload can call
// `restoreCell` to resume a still-running query by re-subscribing.
//
// This module owns *no* React; components read it through the hooks at the end.

import { create } from 'zustand';
import type {
  ApiErrorDetail,
  QueryColumn,
  QuerySnapshot,
  QueryState,
  QueryStats,
} from '@hue-fable/contracts';
import {
  createQuery,
  cancelQuery,
  fetchQuerySnapshot,
  fetchQueryRows,
} from './api';
import { subscribeQueryEvents, type EventSourceFactory, type SseSubscription } from './sse';
import { withAutoLimit } from './sql';
import type { ExecutionUnit } from './executionUnit';

/** A row is an array of cells; values are JSON scalars or null. */
export type ResultRow = ReadonlyArray<unknown>;

/** Per-cell execution record. `idle` cells have no entry at all. */
export interface CellExecution {
  /** Server-assigned query id (stable across reconnects). */
  queryId: string;
  trinoQueryId?: string;
  infoUri?: string;
  state: QueryState;
  stats?: QueryStats;
  columns: QueryColumn[];
  rows: ResultRow[];
  /** Total rows the server reports buffered (may exceed `rows.length` mid-stream). */
  rowCount: number;
  error?: ApiErrorDetail;
  /** True when the server capped the result at maxRows (snapshot.truncated). */
  truncated: boolean;
  startedAt: number;
  finishedAt?: number;
  /** The exact statement text sent to the server (post auto-LIMIT). */
  statement: string;
  /** The unit's offset span in the source, for mapping error line/col back. */
  unitStart: number;
  /** When running >1 statement, which index this is and the total. */
  batchIndex?: number;
  batchTotal?: number;
}

/** Context forwarded to the server with each query. */
export interface ExecutionContext {
  catalog?: string;
  schema?: string;
  notebookId?: string;
}

/** Options controlling a run (auto-LIMIT toggle + value). */
export interface RunOptions {
  autoLimit: boolean;
  limit: number;
}

interface CellRuntime {
  /** The active generation; events from older generations are ignored. */
  generation: number;
  subscription?: SseSubscription;
  /** Resolves when the current run reaches a terminal state (for batches). */
  settle?: { resolve: (state: QueryState) => void };
}

interface ExecutionStoreState {
  cells: Record<string, CellExecution>;
  /** Run one unit on a cell, replacing any prior result. */
  runUnit: (cellId: string, unit: ExecutionUnit, ctx: ExecutionContext, opts: RunOptions) => void;
  /** Run units sequentially, stopping at the first failure (Hue-compatible). */
  runUnits: (
    cellId: string,
    units: ExecutionUnit[],
    ctx: ExecutionContext,
    opts: RunOptions,
  ) => Promise<void>;
  /** Cancel the cell's running query (propagates DELETE to the server). */
  cancel: (cellId: string) => void;
  /** Drop a cell's result entirely (clears the result pane). */
  clear: (cellId: string) => void;
  /** Re-subscribe to a known query (reload/reconnect restore). */
  restoreCell: (cellId: string, queryId: string) => Promise<void>;
}

// Per-cell runtime (subscriptions, generation) is kept outside the reactive
// store so subscribing/unsubscribing never triggers a render.
const runtimes = new Map<string, CellRuntime>();

/** EventSource factory — overridable in tests via `__setEventSourceFactory`. */
let eventSourceFactory: EventSourceFactory | undefined;
export function __setEventSourceFactory(factory: EventSourceFactory | undefined): void {
  eventSourceFactory = factory;
}

/** Summary of a settled execution, written back into the notebook (resultMeta). */
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
 * persist a lightweight summary into `cell.resultMeta` (design.md §4: 結果の要約
 * のみ永続化). Injected to keep the execution store free of the notebook store
 * (no import cycle); a no-op until wired by `__setCellSettledSink`.
 */
let cellSettledSink: ((cellId: string, summary: CellResultSummary) => void) | undefined;
export function __setCellSettledSink(
  sink: ((cellId: string, summary: CellResultSummary) => void) | undefined,
): void {
  cellSettledSink = sink;
}

/** Build + emit the result summary for a settled cell (idempotent enough). */
function emitCellSettled(cellId: string, cell: CellExecution): void {
  if (!cellSettledSink) return;
  cellSettledSink(cellId, {
    trinoQueryId: cell.trinoQueryId,
    state: cell.state,
    rowCount: cell.rowCount,
    columnCount: cell.columns.length,
    elapsedMs: cell.stats?.elapsedTimeMillis ?? (cell.finishedAt ?? Date.now()) - cell.startedAt,
    errorMessage: cell.error?.message,
    finishedAt: new Date(cell.finishedAt ?? Date.now()).toISOString(),
  });
}

function runtimeFor(cellId: string): CellRuntime {
  let rt = runtimes.get(cellId);
  if (!rt) {
    rt = { generation: 0 };
    runtimes.set(cellId, rt);
  }
  return rt;
}

/** Tear down a cell's active subscription (no state change). */
function teardown(cellId: string): void {
  const rt = runtimes.get(cellId);
  if (rt?.subscription) {
    rt.subscription.close();
    rt.subscription = undefined;
  }
}

const TERMINAL: ReadonlySet<QueryState> = new Set(['finished', 'failed', 'canceled']);

export const useExecutionStore = create<ExecutionStoreState>((set, get) => {
  /** Patch a cell's execution record (only if it still belongs to `generation`). */
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

  /** Subscribe to a query and route events into the cell record. */
  const subscribe = (cellId: string, queryId: string, generation: number) => {
    const rt = runtimeFor(cellId);
    rt.subscription = subscribeQueryEvents(
      queryId,
      {
        onEvent: (event) => {
          switch (event.type) {
            case 'state':
              patch(cellId, generation, (prev) => ({ ...prev, state: event.state }));
              break;
            case 'columns':
              patch(cellId, generation, (prev) => ({ ...prev, columns: event.columns }));
              break;
            case 'rows':
              patch(cellId, generation, (prev) => {
                // Append from the chunk's offset; tolerate replay overlap.
                const rows = prev.rows.slice();
                for (let i = 0; i < event.rows.length; i++) {
                  rows[event.offset + i] = event.rows[i]!;
                }
                return { ...prev, rows, rowCount: Math.max(prev.rowCount, rows.length) };
              });
              break;
            case 'stats':
              patch(cellId, generation, (prev) => ({ ...prev, stats: event.stats }));
              break;
            case 'error':
              patch(cellId, generation, (prev) => ({ ...prev, error: event.error }));
              break;
            case 'done':
              patch(cellId, generation, (prev) => ({
                ...prev,
                state: event.state,
                rowCount: Math.max(prev.rowCount, event.rowCount),
                truncated: event.truncated,
                finishedAt: Date.now(),
              }));
              if (runtimeFor(cellId).generation === generation) {
                const settled = get().cells[cellId];
                if (settled) emitCellSettled(cellId, settled);
                rt.settle?.resolve(event.state);
                rt.settle = undefined;
              }
              break;
          }
        },
        onError: () => {
          // Transport dropped before `done`. Leave the last-known state intact;
          // a restore() can resume. We don't mark failed — the query may still
          // be running server-side.
        },
      },
      eventSourceFactory,
    );
  };

  const startQuery = (
    cellId: string,
    statement: string,
    unitStart: number,
    ctx: ExecutionContext,
    batch?: { index: number; total: number },
  ): Promise<QueryState> => {
    // Bump the generation: any in-flight subscription for this cell is now stale.
    const rt = runtimeFor(cellId);
    teardown(cellId);
    const generation = ++rt.generation;

    const settled = new Promise<QueryState>((resolve) => {
      rt.settle = { resolve };
    });

    const record: CellExecution = {
      queryId: '',
      state: 'queued',
      columns: [],
      rows: [],
      rowCount: 0,
      truncated: false,
      startedAt: Date.now(),
      statement,
      unitStart,
      batchIndex: batch?.index,
      batchTotal: batch?.total,
    };
    set((s) => ({ cells: { ...s.cells, [cellId]: record } }));

    createQuery({
      statement,
      catalog: ctx.catalog,
      schema: ctx.schema,
      notebookId: ctx.notebookId,
      cellId,
    })
      .then(({ queryId }) => {
        if (runtimeFor(cellId).generation !== generation) return; // superseded
        patch(cellId, generation, (prev) => ({ ...prev, queryId }));
        subscribe(cellId, queryId, generation);
      })
      .catch((err: unknown) => {
        patch(cellId, generation, (prev) => ({
          ...prev,
          state: 'failed',
          finishedAt: Date.now(),
          error: toErrorDetail(err),
        }));
        const failed = get().cells[cellId];
        if (failed && runtimeFor(cellId).generation === generation) {
          emitCellSettled(cellId, failed);
        }
        rt.settle?.resolve('failed');
        rt.settle = undefined;
      });

    return settled;
  };

  return {
    cells: {},

    runUnit: (cellId, unit, ctx, opts) => {
      const statement = opts.autoLimit ? withAutoLimit(unit.text, opts.limit).sql : unit.text;
      void startQuery(cellId, statement, unit.start, ctx);
    },

    runUnits: async (cellId, units, ctx, opts) => {
      if (units.length === 0) return;
      for (let i = 0; i < units.length; i++) {
        const unit = units[i]!;
        const statement = opts.autoLimit ? withAutoLimit(unit.text, opts.limit).sql : unit.text;
        const finalState = await startQuery(cellId, statement, unit.start, ctx, {
          index: i,
          total: units.length,
        });
        // Hue-compatible: stop the batch at the first non-success terminal state.
        if (finalState !== 'finished') break;
      }
    },

    cancel: (cellId) => {
      const rt = runtimeFor(cellId);
      const cell = get().cells[cellId];
      // Bump generation so the imminent server-side terminal events are ignored.
      rt.generation++;
      teardown(cellId);
      rt.settle?.resolve('canceled');
      rt.settle = undefined;
      if (cell?.queryId) void cancelQuery(cell.queryId);
      if (cell) {
        const canceled: CellExecution = { ...cell, state: 'canceled', finishedAt: Date.now() };
        set((s) => ({ cells: { ...s.cells, [cellId]: canceled } }));
        emitCellSettled(cellId, canceled);
      }
    },

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
        rowCount: snapshot.rowCount,
        error: snapshot.error,
        truncated: snapshot.truncated,
        startedAt: Date.parse(snapshot.submittedAt) || Date.now(),
        finishedAt: snapshot.finishedAt ? Date.parse(snapshot.finishedAt) : undefined,
        statement: '',
        unitStart: 0,
      };
      set((s) => ({ cells: { ...s.cells, [cellId]: record } }));

      // If still in flight, re-subscribe for the rest (SSE replays from start).
      if (!TERMINAL.has(snapshot.state)) {
        subscribe(cellId, queryId, generation);
      }
    },
  };
});

/** Normalise a thrown value into the contract error shape. */
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

// ---- Selector hooks ---------------------------------------------------------

/** The execution record for a cell, or undefined when idle. */
export function useCellExecution(cellId: string): CellExecution | undefined {
  return useExecutionStore((s) => s.cells[cellId]);
}

export type ExecutionActions = Pick<
  ExecutionStoreState,
  'runUnit' | 'runUnits' | 'cancel' | 'clear' | 'restoreCell'
>;

/**
 * Stable action handles. The action closures are created once when the store is
 * built and never change identity, so reading them straight from `getState`
 * gives a referentially-stable object without subscribing to re-renders.
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

/** True while the cell's query is queued or running. */
export function isCellRunning(cell: CellExecution | undefined): boolean {
  return cell?.state === 'queued' || cell?.state === 'running';
}
