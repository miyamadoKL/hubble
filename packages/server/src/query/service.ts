import type { TrinoRequestContext } from '../trino/types';
import type { HistoryRepository } from '../store/history';
import type { OverflowMode } from './execution';
import { QueryExecution } from './execution';
import { QueryRegistry } from './registry';

export interface QueryServiceParams {
  registry: QueryRegistry;
  history: HistoryRepository;
}

export interface SubmitQueryParams {
  statement: string;
  ctx: TrinoRequestContext;
  /** Owning principal — also the `X-Trino-User` (design.md §11). */
  owner: string;
  maxRows?: number;
  overflowMode?: OverflowMode;
  notebookId?: string;
  cellId?: string;
}

/**
 * Bridges the query registry and history persistence: records a history row on
 * submit and updates it when the query settles.
 */
export class QueryService {
  constructor(private readonly params: QueryServiceParams) {}

  get registry(): QueryRegistry {
    return this.params.registry;
  }

  submit(params: SubmitQueryParams): QueryExecution {
    const exec = this.params.registry.submit({
      statement: params.statement,
      ctx: params.ctx,
      maxRows: params.maxRows,
      overflowMode: params.overflowMode,
    });

    // Insert a history row immediately (state at submit time).
    this.params.history.insert({
      id: exec.queryId,
      statement: params.statement,
      catalog: params.ctx.catalog,
      schema: params.ctx.schema,
      state: exec.state,
      owner: params.owner,
      notebookId: params.notebookId,
      cellId: params.cellId,
      submittedAt: new Date(exec.submittedAt).toISOString(),
    });

    // Update on settle.
    void exec.settled.then(() => {
      const elapsedMs =
        exec.finishedAt !== undefined ? Math.max(exec.finishedAt - exec.submittedAt, 0) : 0;
      this.params.history.update(exec.queryId, {
        state: exec.state,
        rowCount: exec.rowCount,
        elapsedMs,
        trinoQueryId: exec.trinoQueryId,
        errorMessage: exec.error?.message,
      });
    });

    return exec;
  }
}
