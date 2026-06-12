import { emptySessionMutations, type TrinoRequestContext } from '../trino/types';
import type { TrinoClient } from '../trino/client';

export interface DrainResult {
  /** Trino's query id (`stats`-bearing response id). */
  trinoQueryId: string;
  /** Total rows produced by the statement (counted, not buffered). */
  rowCount: number;
}

/**
 * Run a statement to completion against Trino, counting result rows without
 * buffering them (Query Scheduling feature: a scheduled run records `row_count`
 * but never retains the data). Mirrors the client's backoff discipline used by
 * the streaming registry. Throws on any Trino error (the caller classifies it).
 */
export async function drainStatement(
  client: TrinoClient,
  statement: string,
  ctx: TrinoRequestContext,
): Promise<DrainResult> {
  const mutations = emptySessionMutations();
  let page = await client.start(statement, ctx, mutations);
  const trinoQueryId = page.id;
  let rowCount = page.data ? page.data.length : 0;

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
    if (page.data) rowCount += page.data.length;
  }
  return { trinoQueryId, rowCount };
}
