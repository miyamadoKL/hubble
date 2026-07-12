/** Workflow 実行ヘルパーの中断境界を検証する。 */
import { describe, expect, it, vi } from 'vitest';
import type { StatementClient } from '../engine/types';
import type { ResultJsonlCapture } from '../resultStore/jsonl';
import { drainStatementWithCapture } from './execute';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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

  it('capture の背圧が解消するまで次ページを取得しない', async () => {
    const writeStarted = deferred();
    const releaseWrite = deferred();
    const advance = vi.fn(async () => ({
      id: 'query-1',
      data: [[2]],
      stats: { state: 'FINISHED' },
    }));
    const client = {
      start: vi.fn(async () => ({
        id: 'query-1',
        nextUri: 'https://trino.test/query-1/1',
        data: [[1]],
        stats: { state: 'RUNNING' },
      })),
      advance,
      cancel: vi.fn(async () => undefined),
      waitBackoff: vi.fn(async () => undefined),
    } as unknown as StatementClient;
    const capture = {
      writeColumns: vi.fn(),
      writeRows: vi.fn(async () => {
        writeStarted.resolve();
        await releaseWrite.promise;
      }),
    } as unknown as ResultJsonlCapture;

    const running = drainStatementWithCapture(client, 'SELECT 1', {}, capture);
    await writeStarted.promise;
    expect(advance).not.toHaveBeenCalled();
    releaseWrite.resolve();

    await expect(running).resolves.toEqual({ rowCount: 2 });
    expect(advance).toHaveBeenCalledOnce();
  });
});
