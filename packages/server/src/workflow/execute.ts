/**
 * ワークフローステップ実行時に Trino ステートメントを完走させ、
 * 行数を数えつつ ResultJsonlCapture へ結果をストリーミングする。
 */
import { emptySessionMutations, toQueryColumns, type TrinoRequestContext } from '../trino/types';
import type { StatementClient } from '../engine/types';
import type { ResultJsonlCapture } from '../resultStore/jsonl';
import { createSqlAbortError } from '../engine/sql/abort';
import { driveStatementPages } from '../engine/statementDriver';

export interface DrainWithCaptureResult {
  rowCount: number;
}

/**
 * ステートメントを完走し、行数を数える。capture があれば列と行を gzip JSONL へ流す。
 */
export async function drainStatementWithCapture(
  client: StatementClient,
  statement: string,
  ctx: TrinoRequestContext,
  capture?: ResultJsonlCapture,
  signal?: AbortSignal,
): Promise<DrainWithCaptureResult> {
  const mutations = emptySessionMutations();
  throwIfAborted(signal);
  let rowCount = 0;
  // capture の書き込み完了を observer 内で待つため、その背圧が解消するまで
  // 共通 driver は次ページを取得しない。中断時の current nextUri も driver が解放する。
  await driveStatementPages({
    client,
    statement,
    ctx,
    mutations,
    signal,
    onPage: async ({ page }) => {
      if (page.columns && capture) capture.writeColumns(toQueryColumns(page.columns));
      if (!page.data) return;
      rowCount += page.data.length;
      if (capture) await capture.writeRows(page.data);
    },
  });
  return { rowCount };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw createSqlAbortError();
}
