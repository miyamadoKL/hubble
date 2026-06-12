import { TrinoClient } from './client';
import { emptySessionMutations, type TrinoColumn, type TrinoRequestContext } from './types';

export interface TrinoQueryResult {
  columns: TrinoColumn[];
  rows: unknown[][];
}

/**
 * Run a statement to completion and collect all rows. Used for metadata queries
 * (`information_schema`, `DESCRIBE`, sample rows) where result sets are small.
 * User queries go through the streaming registry instead.
 */
export async function runToCompletion(
  client: TrinoClient,
  statement: string,
  ctx: TrinoRequestContext,
): Promise<TrinoQueryResult> {
  const mutations = emptySessionMutations();
  let page = await client.start(statement, ctx, mutations);
  let columns: TrinoColumn[] = page.columns ?? [];
  const rows: unknown[][] = [];
  if (page.data) rows.push(...page.data);

  // Same backoff discipline as the streaming loop: data pages advance with zero
  // delay; only data-less pages escalate the backoff.
  let idleAttempt = 0;
  while (page.nextUri) {
    if (page.data && page.data.length > 0) {
      idleAttempt = 0;
    } else {
      await client.waitBackoff(idleAttempt);
      idleAttempt += 1;
    }
    page = await client.advance(page.nextUri, ctx, mutations);
    if (page.columns && columns.length === 0) columns = page.columns;
    if (page.data) rows.push(...page.data);
  }
  return { columns, rows };
}
