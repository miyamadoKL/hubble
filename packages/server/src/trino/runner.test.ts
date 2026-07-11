import { describe, expect, it, vi } from 'vitest';
import type { StatementClient } from '../engine/types';
import { runToCompletion } from './runner';

describe('runToCompletion', () => {
  it('期限超過時に残存クエリを cancel する', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const client = {
      start: vi.fn().mockResolvedValue({ nextUri: 'next-1' }),
      advance: vi.fn((_uri, _ctx, _mutations, signal: AbortSignal) => {
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }),
      cancel,
      waitBackoff: vi.fn().mockResolvedValue(undefined),
    } as unknown as StatementClient;

    await expect(runToCompletion(client, 'SELECT 1', {}, { timeoutMs: 5 })).rejects.toThrow(
      'aborted',
    );
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith('next-1', {});
  });

  it('正常完了時は結果を返し cancel しない', async () => {
    const cancel = vi.fn();
    const client = {
      start: vi.fn().mockResolvedValue({
        columns: [{ name: 'n', type: 'bigint' }],
        data: [[1]],
      }),
      advance: vi.fn(),
      cancel,
      waitBackoff: vi.fn(),
    } as unknown as StatementClient;

    await expect(runToCompletion(client, 'SELECT 1', {})).resolves.toEqual({
      columns: [{ name: 'n', type: 'bigint' }],
      rows: [[1]],
    });
    expect(cancel).not.toHaveBeenCalled();
  });
});
