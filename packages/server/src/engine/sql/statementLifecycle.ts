/** MySQL と PostgreSQL に共通するページ実行の状態遷移を管理する。 */
import type { TrinoColumn } from '../../trino/types';
import type { TrinoStatementResponse } from '../../trino/types';
import { createSqlAbortError } from './abort';
import { buildPage } from './response';

/** 共通状態機械が必要とする実行状態。 */
export interface SqlPageExecution {
  queryId: string;
  columns?: TrinoColumn[];
  rowCount: number;
  released: boolean;
}

interface SqlLifecycleAdapter<T extends SqlPageExecution> {
  read: (execution: T, signal?: AbortSignal) => Promise<{ rows: unknown[][]; done: boolean }>;
  release: (execution: T, signal?: AbortSignal) => Promise<void>;
  destroy: (execution: T, reason?: Error) => void;
  throwDriverError: (error: unknown) => never;
}

/** SQL StatementClient の登録、advance、cancel を一つの状態機械として提供する。 */
export class SqlStatementLifecycle<T extends SqlPageExecution> {
  private readonly executions = new Map<string, T>();

  constructor(private readonly adapter: SqlLifecycleAdapter<T>) {}

  /** start が初期ページを作った後の実行を登録する。 */
  register(execution: T): void {
    this.executions.set(execution.queryId, execution);
  }

  /** release または destroy 後の実行をレジストリから除く。 */
  remove(queryId: string): void {
    this.executions.delete(queryId);
  }

  /** 次ページを読み、終端と異常時の cleanup を一貫して処理する。 */
  async advance(nextUri: string, signal?: AbortSignal): Promise<TrinoStatementResponse> {
    const execution = this.executions.get(nextUri);
    if (!execution) return buildPage(nextUri, undefined, [], undefined, 0);
    if (signal?.aborted) {
      this.adapter.destroy(execution, createSqlAbortError());
      throw createSqlAbortError();
    }
    try {
      const { rows, done } = await this.adapter.read(execution, signal);
      execution.rowCount += rows.length;
      if (done) await this.adapter.release(execution, signal);
      return buildPage(
        execution.queryId,
        undefined,
        rows,
        done ? undefined : nextUri,
        execution.rowCount,
      );
    } catch (error) {
      if (!execution.released) await this.adapter.release(execution);
      if (signal?.aborted) throw createSqlAbortError();
      this.adapter.throwDriverError(error);
    }
  }

  /** 実行中リソースを冪等に破棄する。 */
  cancel(nextUri: string): void {
    const execution = this.executions.get(nextUri);
    if (execution) this.adapter.destroy(execution);
  }
}

/** HTTP ポーリングを行わない SQL ドライバ共通の backoff 実装。 */
export async function noSqlBackoff(attempt: number, signal?: AbortSignal): Promise<void> {
  void attempt;
  void signal;
}
