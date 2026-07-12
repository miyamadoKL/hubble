/**
 * Alert 評価用のクエリ実行ヘルパー。
 * 結果行を上限付きでメモリに集め、閾値比較に使う。
 */
import { emptySessionMutations, type TrinoColumn, type TrinoRequestContext } from '../trino/types';
import type { StatementClient } from '../engine/types';
import { createSqlAbortError } from '../engine/sql/abort';

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
  let cancelUri: string | undefined;
  try {
    throwIfAborted(signal);
    let page = await client.start(statement, ctx, mutations, signal);
    cancelUri = page.nextUri;
    throwIfAborted(signal);
    let columns: TrinoColumn[] = page.columns ?? [];
    const rows: unknown[][] = [];
    if (page.data) {
      for (const row of page.data) {
        rows.push(row);
        if (rows.length >= maxRows) {
          await cancelRemainingPage(client, page.nextUri, ctx);
          throwIfAborted(signal);
          return { columns, rows, truncated: true };
        }
      }
    }

    let idleAttempt = 0;
    while (page.nextUri) {
      cancelUri = page.nextUri;
      const hadData = page.data !== undefined && page.data.length > 0;
      if (hadData) {
        idleAttempt = 0;
      } else {
        await client.waitBackoff(idleAttempt, signal);
        throwIfAborted(signal);
        idleAttempt += 1;
      }
      page = await client.advance(page.nextUri, ctx, mutations, signal);
      cancelUri = page.nextUri;
      throwIfAborted(signal);
      if (page.columns && columns.length === 0) columns = page.columns;
      if (page.data) {
        for (const row of page.data) {
          rows.push(row);
          if (rows.length >= maxRows) {
            await cancelRemainingPage(client, page.nextUri, ctx);
            throwIfAborted(signal);
            return { columns, rows, truncated: true };
          }
        }
      }
    }
    return { columns, rows, truncated: false };
  } catch (error) {
    if (signal?.aborted) await cancelRemainingPage(client, cancelUri, ctx);
    throw error;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw createSqlAbortError();
}

/** 打ち切り後も残るクエリを可能な範囲で停止する。 */
async function cancelRemainingPage(
  client: StatementClient,
  nextUri: string | undefined,
  ctx: TrinoRequestContext,
): Promise<void> {
  if (nextUri === undefined) return;
  try {
    await client.cancel(nextUri, ctx);
  } catch {
    // cancel失敗は結果の打ち切り判定へ影響させない。
  }
}

/** カラム名からインデックスを解決する。見つからなければ -1。 */
export function columnIndex(columns: readonly TrinoColumn[], name: string): number {
  return columns.findIndex((c) => c.name === name);
}
