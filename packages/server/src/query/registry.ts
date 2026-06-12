import type { TrinoClient } from '../trino/client';
import type { TrinoRequestContext } from '../trino/types';
import { AppError } from '../errors';
import { newId } from '../util/id';
import { QueryExecution, type OverflowMode } from './execution';

export interface QueryRegistryOptions {
  client: TrinoClient;
  /** Default cap on buffered rows per query. */
  defaultMaxRows: number;
  /** Maximum concurrently-running queries. */
  concurrency: number;
  /** Retention for finished queries, in ms. */
  ttlMs: number;
  defaultOverflowMode: OverflowMode;
  /** Sweep interval in ms (default ttlMs/4, min 60s). Set 0 to disable timer. */
  sweepIntervalMs?: number;
  now?: () => number;
  /** Called when a query settles (for history bookkeeping). */
  onSettled?: (exec: QueryExecution) => void;
}

export interface SubmitParams {
  statement: string;
  ctx: TrinoRequestContext;
  maxRows?: number;
  overflowMode?: OverflowMode;
}

/**
 * In-memory registry of query executions (design.md §3). Owns the concurrency
 * semaphore, the queued-waiters list, and the TTL sweep for finished queries.
 */
export class QueryRegistry {
  private readonly executions = new Map<string, QueryExecution>();
  private readonly client: TrinoClient;
  private readonly defaultMaxRows: number;
  private readonly concurrency: number;
  private readonly ttlMs: number;
  private readonly defaultOverflowMode: OverflowMode;
  private readonly now: () => number;
  private readonly onSettled?: (exec: QueryExecution) => void;

  private running = 0;
  private readonly waiters: Array<() => void> = [];
  private sweepTimer?: ReturnType<typeof setInterval>;

  constructor(options: QueryRegistryOptions) {
    this.client = options.client;
    this.defaultMaxRows = options.defaultMaxRows;
    this.concurrency = options.concurrency;
    this.ttlMs = options.ttlMs;
    this.defaultOverflowMode = options.defaultOverflowMode;
    this.now = options.now ?? Date.now;
    this.onSettled = options.onSettled;

    const interval = options.sweepIntervalMs ?? Math.max(Math.floor(this.ttlMs / 4), 60_000);
    if (interval > 0 && this.ttlMs > 0) {
      this.sweepTimer = setInterval(() => this.sweep(), interval);
      // Don't keep the process alive solely for the sweep timer.
      this.sweepTimer.unref?.();
    }
  }

  /** Submit a new query. Returns immediately with the assigned execution. */
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
    void this.scheduleRun(exec);
    return exec;
  }

  private async scheduleRun(exec: QueryExecution): Promise<void> {
    await this.acquireSlot();
    try {
      // If it was canceled while queued, run() short-circuits to canceled.
      await exec.run();
    } finally {
      this.releaseSlot();
    }
  }

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

  private releaseSlot(): void {
    this.running -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }

  get(queryId: string): QueryExecution | undefined {
    return this.executions.get(queryId);
  }

  getOrThrow(queryId: string): QueryExecution {
    const exec = this.executions.get(queryId);
    if (!exec) throw AppError.notFound(`Query ${queryId} not found`);
    return exec;
  }

  /** Remove finished executions older than the TTL. Returns count removed. */
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
  size(): number {
    return this.executions.size;
  }

  /** Cancel all running queries and stop the sweep timer (shutdown). */
  async shutdown(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    await Promise.all(
      [...this.executions.values()].filter((e) => !e.isTerminal).map((e) => e.requestCancel()),
    );
  }
}
