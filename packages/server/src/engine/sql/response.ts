/**
 * StatementClient 模倣用の TrinoStatementResponse 組み立て。
 */
import type { TrinoColumn, TrinoStatementResponse } from '../../trino/types';
import { SQL_BATCH_SIZE } from './constants';

let queryCounter = 0;

/** 新しいクエリ id を発番する。 */
export function nextQueryId(prefix: string): string {
  return `${prefix}_${++queryCounter}`;
}

/** RUNNING 状態の stats を返す。 */
export function runningStats(): TrinoStatementResponse['stats'] {
  return { state: 'RUNNING' };
}

/** FINISHED 状態の stats を返す。 */
export function finishedStats(rowCount: number): TrinoStatementResponse['stats'] {
  return { state: 'FINISHED', processedRows: rowCount };
}

/**
 * 1 ページ分の TrinoStatementResponse を組み立てる。
 * @param id - クエリ id。
 * @param columns - 列定義(初回ページのみ)。
 * @param data - 行データ。
 * @param nextUri - 続きがある場合のトークン。
 * @param rowCount - 累計処理行数(stats 用)。
 */
export function buildPage(
  id: string,
  columns: TrinoColumn[] | undefined,
  data: unknown[][],
  nextUri: string | undefined,
  rowCount: number,
): TrinoStatementResponse {
  const finished = nextUri === undefined;
  return {
    id,
    nextUri,
    columns,
    data: data.length > 0 ? data : undefined,
    stats: finished ? finishedStats(rowCount) : runningStats(),
  };
}

/** バッチサイズを返す。 */
export function batchSize(): number {
  return SQL_BATCH_SIZE;
}