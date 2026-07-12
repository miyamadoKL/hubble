import { describe, expect, it, vi } from 'vitest';
import type { StatementClient } from '../engine/types';
import type { TrinoStatementResponse } from '../trino/types';
import { fetchStatementRows } from './execute';

function clientForPages(
  first: TrinoStatementResponse,
  next: TrinoStatementResponse[] = [],
  cancelImpl: () => Promise<void> = async () => undefined,
): { client: StatementClient; cancel: ReturnType<typeof vi.fn> } {
  const cancel = vi.fn(cancelImpl);
  const advance = vi.fn(async () => {
    const page = next.shift();
    if (page === undefined) throw new Error('unexpected advance');
    return page;
  });
  return {
    client: {
      start: vi.fn(async () => first),
      advance,
      cancel,
      waitBackoff: vi.fn(async () => undefined),
    } as unknown as StatementClient,
    cancel,
  };
}

describe('fetchStatementRows truncation cancellation', () => {
  it('cancels the remaining nextUri when the first page reaches the row limit', async () => {
    const { client, cancel } = clientForPages({
      id: 'query-1',
      nextUri: 'https://trino.test/next/1',
      columns: [{ name: 'value', type: 'bigint' }],
      data: [[1], [2]],
      stats: { state: 'RUNNING' },
    });

    const result = await fetchStatementRows(client, 'SELECT value', { user: 'alice' }, 2);

    expect(result).toMatchObject({ rows: [[1], [2]], truncated: true });
    expect(cancel).toHaveBeenCalledWith('https://trino.test/next/1', { user: 'alice' });
  });

  it('cancels the remaining nextUri when a later page reaches the row limit', async () => {
    const { client, cancel } = clientForPages(
      {
        id: 'query-2',
        nextUri: 'https://trino.test/next/1',
        columns: [{ name: 'value', type: 'bigint' }],
        data: [[1]],
        stats: { state: 'RUNNING' },
      },
      [
        {
          id: 'query-2',
          nextUri: 'https://trino.test/next/2',
          data: [[2]],
          stats: { state: 'RUNNING' },
        },
      ],
    );

    const result = await fetchStatementRows(client, 'SELECT value', {}, 2);

    expect(result.truncated).toBe(true);
    expect(cancel).toHaveBeenCalledWith('https://trino.test/next/2', {});
  });

  it('returns a truncated result when cancellation fails', async () => {
    const { client, cancel } = clientForPages(
      {
        id: 'query-3',
        nextUri: 'https://trino.test/next/1',
        data: [[1]],
        stats: { state: 'RUNNING' },
      },
      [],
      async () => {
        throw new Error('cancel failed');
      },
    );

    await expect(fetchStatementRows(client, 'SELECT value', {}, 1)).resolves.toMatchObject({
      rows: [[1]],
      truncated: true,
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('start が中断を無視して応答しても残存クエリを停止して失敗する', async () => {
    const controller = new AbortController();
    const cancel = vi.fn(async () => undefined);
    const client = {
      start: vi.fn(async () => {
        controller.abort();
        return {
          id: 'query-abort',
          nextUri: 'https://trino.test/query-abort/1',
          stats: { state: 'QUEUED' },
        };
      }),
      advance: vi.fn(),
      cancel,
      waitBackoff: vi.fn(),
    } as unknown as StatementClient;

    await expect(
      fetchStatementRows(client, 'SELECT 1', {}, 10, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledWith('https://trino.test/query-abort/1', {});
    expect(client.advance).not.toHaveBeenCalled();
  });
});
