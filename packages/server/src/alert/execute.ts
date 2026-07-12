/**
 * Alert 評価用のクエリ実行ヘルパー。
 * 結果行を上限付きでメモリに集め、閾値比較に使う。
 */
import { emptySessionMutations, type TrinoColumn, type TrinoRequestContext } from '../trino/types';
import type { StatementClient } from '../engine/types';
import { createSqlAbortError } from '../engine/sql/abort';
import { driveStatementPages } from '../engine/statementDriver';

export interface FetchRowsResult {
  columns: TrinoColumn[];
  rows: unknown[][];
  truncated: boolean;
}

/** Alert 評価で保持する最大行数。 */
export const ALERT_MAX_ROWS = 10_000;

/**
 * ステートメントを完走し、行を上限付きで収集する。
 */
export async function fetchStatementRows(
  client: StatementClient,
  statement: string,
  ctx: TrinoRequestContext,
  maxRows = ALERT_MAX_ROWS,
  signal?: AbortSignal,
): Promise<FetchRowsResult> {
  const mutations = emptySessionMutations();
  throwIfAborted(signal);
  let columns: TrinoColumn[] = [];
  const rows: unknown[][] = [];
  let truncated = false;
  // 上限到達時は observer から追走を打ち切る。残った nextUri の DELETE は
  // 共通 driver がベストエフォートで行い、失敗しても truncated 判定は維持する。
  await driveStatementPages({
    client,
    statement,
    ctx,
    mutations,
    signal,
    onPage: ({ page }) => {
      if (page.columns && columns.length === 0) columns = page.columns;
      for (const row of page.data ?? []) {
        rows.push(row);
        if (rows.length >= maxRows) {
          truncated = true;
          return 'stop';
        }
      }
      return 'continue';
    },
  });
  return { columns, rows, truncated };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw createSqlAbortError();
}

/** カラム名からインデックスを解決する。見つからなければ -1。 */
export function columnIndex(columns: readonly TrinoColumn[], name: string): number {
  return columns.findIndex((c) => c.name === name);
}
