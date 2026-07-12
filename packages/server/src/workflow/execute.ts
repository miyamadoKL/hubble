/**
 * ワークフローステップ実行時に Trino ステートメントを完走させ、
 * 行数を数えつつ ResultJsonlCapture へ結果をストリーミングする。
 */
import { emptySessionMutations, toQueryColumns, type TrinoRequestContext } from '../trino/types';
import type { StatementClient } from '../engine/types';
import type { ResultJsonlCapture } from '../resultStore/jsonl';
import { createSqlAbortError } from '../engine/sql/abort';

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
  let cancelUri: string | undefined;
  try {
    throwIfAborted(signal);
    let page = await client.start(statement, ctx, mutations, signal);
    cancelUri = page.nextUri;
    throwIfAborted(signal);
    if (page.columns && capture) {
      capture.writeColumns(toQueryColumns(page.columns));
    }
    let rowCount = page.data ? page.data.length : 0;
    if (page.data && capture) {
      await capture.writeRows(page.data);
      throwIfAborted(signal);
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
      if (page.columns && capture) {
        capture.writeColumns(toQueryColumns(page.columns));
      }
      if (page.data) {
        rowCount += page.data.length;
        if (capture) {
          await capture.writeRows(page.data);
          throwIfAborted(signal);
        }
      }
    }
    return { rowCount };
  } catch (error) {
    if (signal?.aborted && cancelUri) {
      try {
        await client.cancel(cancelUri, ctx);
      } catch {
        // shutdown中は元のAbortを優先し、cancel失敗を上書きしない。
      }
    }
    throw error;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw createSqlAbortError();
}
