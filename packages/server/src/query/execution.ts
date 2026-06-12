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

export type OverflowMode = 'truncate' | 'cancel';

export interface QueryExecutionInit {
  queryId: string;
  statement: string;
  ctx: TrinoRequestContext;
  maxRows: number;
  overflowMode: OverflowMode;
  client: TrinoClient;
  /** Wall-clock time source (injectable for tests). */
  now?: () => number;
  /** Called when the query reaches a terminal state. */
  onSettled?: (exec: QueryExecution) => void;
}

type Listener = (event: QueryEvent) => void;

/**
 * A single query's lifecycle and buffered result. Drives the Trino polling
 * loop, accumulates rows in an in-memory page store, and fans out SSE events
 * to subscribers. Terminal states: finished | failed | canceled.
 */
export class QueryExecution {
  readonly queryId: string;
  readonly statement: string;
  readonly ctx: TrinoRequestContext;
  readonly maxRows: number;
  readonly overflowMode: OverflowMode;
  readonly submittedAt: number;

  private readonly client: TrinoClient;
  private readonly now: () => number;
  private readonly onSettled?: (exec: QueryExecution) => void;

  state: QueryState = 'queued';
  trinoQueryId?: string;
  infoUri?: string;
  columns: QueryColumn[] = [];
  stats?: QueryStats;
  error?: ApiErrorDetail;
  finishedAt?: number;
  /** True once buffering stopped at `maxRows` while the query kept running. */
  truncated = false;
  /** Session mutations to reflect on completion (set-catalog/schema/session). */
  readonly mutations: TrinoSessionMutations = emptySessionMutations();

  /** Buffered rows (capped at maxRows when overflowMode === 'truncate'). */
  private readonly rows: unknown[][] = [];
  /** Total rows produced by Trino (may exceed buffered count when truncated). */
  private producedRows = 0;

  private readonly listeners = new Set<Listener>();
  private readonly abort = new AbortController();
  /** The latest nextUri, used for DELETE cancellation. */
  private currentNextUri?: string;
  private cancelRequested = false;
  /** Resolves when the execution reaches a terminal state. */
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
    this.settled = new Promise((resolve) => {
      this.settledResolve = resolve;
    });
  }

  get rowCount(): number {
    return this.producedRows;
  }

  get bufferedCount(): number {
    return this.rows.length;
  }

  get isTerminal(): boolean {
    return this.state === 'finished' || this.state === 'failed' || this.state === 'canceled';
  }

  /** Read a page of buffered rows. */
  getRows(offset: number, limit: number): unknown[][] {
    if (offset < 0) offset = 0;
    return this.rows.slice(offset, offset + limit);
  }

  /** Iterate buffered rows (for CSV streaming). Index-based so concurrent
   * appends during an in-flight query are picked up. */
  rowAt(index: number): unknown[] | undefined {
    return this.rows[index];
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: QueryEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        // A failing listener must not break the loop or other listeners.
      }
    }
  }

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
  bufferedRows(): unknown[][] {
    return this.rows.slice();
  }

  private setState(state: QueryState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit({ type: 'state', state });
  }

  private setColumns(columns: QueryColumn[]): void {
    if (columns.length === 0 || this.columns.length > 0) return;
    this.columns = columns;
    this.emit({ type: 'columns', columns });
  }

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

  private setStats(stats: QueryStats): void {
    this.stats = stats;
    this.emit({ type: 'stats', stats });
  }

  /** Request cancellation. Safe to call before, during, or after the run. */
  async requestCancel(): Promise<void> {
    if (this.isTerminal) return;
    this.cancelRequested = true;
    this.abort.abort();
    if (this.currentNextUri) {
      await this.client.cancel(this.currentNextUri, this.ctx);
    }
  }

  /**
   * Drive the polling loop to completion. Resolves (never rejects) when the
   * query reaches a terminal state; failures are recorded as `error` + state.
   */
  async run(): Promise<void> {
    try {
      if (this.cancelRequested) {
        this.settle('canceled', { code: 'CANCELED', message: 'Query canceled before start' });
        return;
      }
      const signal = this.abort.signal;
      let page = await this.client.start(this.statement, this.ctx, this.mutations, signal);
      this.trinoQueryId = page.id;
      if (page.infoUri) this.infoUri = page.infoUri;
      this.setState('running');
      this.applyPage(page);

      // Backoff discipline (Trino client protocol): when a page carries data,
      // fetch the next page with zero delay and reset the counter. Only escalate
      // the backoff while data-less pages (queued/planning/empty) repeat, so a
      // streaming result is never throttled to ~1 page/sec.
      let idleAttempt = 0;
      while (page.nextUri) {
        this.currentNextUri = page.nextUri;
        if (this.cancelRequested) {
          await this.client.cancel(page.nextUri, this.ctx);
          this.settle('canceled', { code: 'CANCELED', message: 'Query canceled' });
          return;
        }
        if (this.overflowMode === 'cancel' && this.truncated) {
          await this.client.cancel(page.nextUri, this.ctx);
          this.settle('finished');
          return;
        }
        const hadData = pageHasData(page);
        if (hadData) {
          idleAttempt = 0;
        } else {
          await this.client.waitBackoff(idleAttempt, signal);
          idleAttempt += 1;
        }
        if (this.cancelRequested) {
          await this.client.cancel(page.nextUri, this.ctx);
          this.settle('canceled', { code: 'CANCELED', message: 'Query canceled' });
          return;
        }
        page = await this.client.advance(page.nextUri, this.ctx, this.mutations, signal);
        this.applyPage(page);
      }
      this.currentNextUri = undefined;
      this.settle('finished');
    } catch (err) {
      if (this.cancelRequested) {
        this.settle('canceled', { code: 'CANCELED', message: 'Query canceled' });
        return;
      }
      const { detail } = toErrorResponse(err);
      // A structured Trino/user error is a query failure; transport faults too.
      const state: QueryState = err instanceof AppError && err.status >= 500 ? 'failed' : 'failed';
      this.settle(state, detail);
    }
  }

  private applyPage(page: Awaited<ReturnType<TrinoClient['start']>>): void {
    if (page.columns) this.setColumns(toQueryColumns(page.columns));
    if (page.data) this.appendRows(page.data);
    if (page.stats) this.setStats(toQueryStats(page.stats));
  }

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
function pageHasData(page: { data?: unknown[][] }): boolean {
  return page.data !== undefined && page.data.length > 0;
}
