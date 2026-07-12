/** 再実行結果イベント generator のページ所有権を検証する。 */
import { describe, expect, it, vi } from 'vitest';
import type { QueryEngine, StatementClient } from '../engine/types';
import { QueryExecution } from './execution';
import { streamQueryResultEvents } from './resultEvents';

describe('streamQueryResultEvents', () => {
  it('consumer が generator を閉じた場合は残った nextUri をキャンセルする', async () => {
    const cancel = vi.fn(async () => undefined);
    const client = {
      start: vi.fn(async () => ({
        id: 'query-1',
        nextUri: 'next-1',
        columns: [{ name: 'n', type: 'bigint' }],
        data: [[1]],
        stats: { state: 'RUNNING' },
      })),
      advance: vi.fn(),
      cancel,
      waitBackoff: vi.fn(async () => undefined),
    } as unknown as StatementClient;
    const engine = {
      isClosed: () => false,
      downloadClient: () => client,
    } as unknown as QueryEngine;
    const exec = new QueryExecution({
      queryId: 'qry_1',
      statement: 'SELECT 1',
      ctx: {},
      datasourceId: 'trino-default',
      maxRows: 1,
      overflowMode: 'truncate',
      client,
      engine,
    });
    exec.state = 'finished';
    exec.truncated = true;

    const resolved = streamQueryResultEvents(exec, { client });
    expect(resolved.source).toBe('reexec');
    await resolved.events.next();
    await resolved.events.return(undefined);

    expect(cancel).toHaveBeenCalledWith('next-1', {
      source: 'hubble-download',
    });
  });
});
