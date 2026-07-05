/**
 * ワークフローステップ実行時に Trino ステートメントを完走させ、
 * 行数を数えつつ ResultJsonlCapture へ結果をストリーミングする。
 */
import { emptySessionMutations, toQueryColumns, type TrinoRequestContext } from '../trino/types';
import type { StatementClient } from '../engine/types';
import type { ResultJsonlCapture } from '../resultStore/jsonl';

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
): Promise<DrainWithCaptureResult> {
  const mutations = emptySessionMutations();
  let page = await client.start(statement, ctx, mutations);
  if (page.columns && capture) {
    capture.writeColumns(toQueryColumns(page.columns));
  }
  let rowCount = page.data ? page.data.length : 0;
  if (page.data && capture) {
    capture.writeRows(page.data);
  }

  let idleAttempt = 0;
  while (page.nextUri) {
    const hadData = page.data !== undefined && page.data.length > 0;
    if (hadData) {
      idleAttempt = 0;
    } else {
      await client.waitBackoff(idleAttempt);
      idleAttempt += 1;
    }
    page = await client.advance(page.nextUri, ctx, mutations);
    if (page.columns && capture) {
      capture.writeColumns(toQueryColumns(page.columns));
    }
    if (page.data) {
      rowCount += page.data.length;
      if (capture) capture.writeRows(page.data);
    }
  }
  return { rowCount };
}
