/** Workflow 実行ヘルパーの中断境界を検証する。 */
import { describe, expect, it, vi } from 'vitest';
import type { StatementClient } from '../engine/types';
import { drainStatementWithCapture } from './execute';

describe('drainStatementWithCapture', () => {
  it('start が中断を無視して応答しても残存クエリを停止して失敗する', async () => {
    const controller = new AbortController();
    const cancel = vi.fn(async () => undefined);
    const client = {
      start: vi.fn(async () => {
        controller.abort();
        return {
          id: 'query-1',
          nextUri: 'https://trino.test/query-1/1',
          stats: { state: 'QUEUED' },
        };
      }),
      advance: vi.fn(),
      cancel,
      waitBackoff: vi.fn(),
    } as unknown as StatementClient;

    await expect(
      drainStatementWithCapture(client, 'SELECT 1', {}, undefined, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledWith('https://trino.test/query-1/1', {});
    expect(client.advance).not.toHaveBeenCalled();
  });
});
