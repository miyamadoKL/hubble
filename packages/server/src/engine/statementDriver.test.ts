/** 共通ステートメントページ driver の所有権と順序を検証する。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StatementClient } from './types';
import { driveStatementPages, StatementPageCursor, statementPages } from './statementDriver';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('statement page driver', () => {
  it('同時 cancel を一回にまとめる', async () => {
    const release = deferred();
    const cancel = vi.fn(async () => release.promise);
    const client = { cancel } as unknown as StatementClient;
    const cursor = new StatementPageCursor(client, {});
    cursor.update('next-1');

    const first = cursor.cancel();
    const second = cursor.cancel();
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce();
    release.resolve();
    await Promise.all([first, second]);
  });

  it('cancel 失敗後の明示的な再試行では DELETE を再送する', async () => {
    const cancel = vi
      .fn<StatementClient['cancel']>()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce(undefined);
    const client = { cancel } as unknown as StatementClient;
    const cursor = new StatementPageCursor(client, {});
    cursor.update('next-1');

    await expect(cursor.cancel()).rejects.toThrow('temporary failure');
    await expect(cursor.cancel()).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it('応答しない cancel を期限で解放し、遅延 rejection 後も再試行できる', async () => {
    vi.useFakeTimers();
    let rejectLate!: (error: unknown) => void;
    const late = new Promise<void>((_resolve, reject) => {
      rejectLate = reject;
    });
    const cancel = vi
      .fn<StatementClient['cancel']>()
      .mockImplementationOnce(() => late)
      .mockResolvedValueOnce(undefined);
    const client = { cancel } as unknown as StatementClient;
    const cursor = new StatementPageCursor(client, {}, 100);
    cursor.update('next-1');

    const first = cursor.cancel().then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await vi.advanceTimersByTimeAsync(100);
    await expect(first).resolves.toMatchObject({
      ok: false,
      error: expect.objectContaining({ message: 'Statement cancel timed out after 100ms' }),
    });
    rejectLate(new Error('late failure'));
    await Promise.resolve();

    await expect(cursor.cancel()).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it('driver の best-effort cancel を指定期限で打ち切る', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const client = {
      start: vi.fn(async () => ({ id: 'q1', nextUri: 'next-1', stats: { state: 'RUNNING' } })),
      advance: vi.fn(),
      cancel,
      waitBackoff: vi.fn(async () => undefined),
    } as unknown as StatementClient;

    const running = driveStatementPages({
      client,
      statement: 'SELECT 1',
      ctx: {},
      cancelTimeoutMs: 50,
      onPage: () => 'stop',
    });
    await vi.advanceTimersByTimeAsync(49);
    expect(cancel).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);

    await expect(running).resolves.toMatchObject({ completed: false });
  });

  it('observer の完了を待ってから次ページを取得する', async () => {
    const observerStarted = deferred();
    const releaseObserver = deferred();
    const advance = vi.fn(async () => ({ id: 'q1', stats: { state: 'FINISHED' }, data: [[2]] }));
    const client = {
      start: vi.fn(async () => ({
        id: 'q1',
        nextUri: 'next-1',
        stats: { state: 'RUNNING' },
        data: [[1]],
      })),
      advance,
      cancel: vi.fn(async () => undefined),
      waitBackoff: vi.fn(async () => undefined),
    } as unknown as StatementClient;

    const running = driveStatementPages({
      client,
      statement: 'SELECT 1',
      ctx: {},
      onPage: async ({ first }) => {
        if (!first) return;
        observerStarted.resolve();
        await releaseObserver.promise;
      },
    });
    await observerStarted.promise;
    expect(advance).not.toHaveBeenCalled();
    releaseObserver.resolve();
    await running;
    expect(advance).toHaveBeenCalledOnce();
  });

  it('observer の早期打ち切りで残った nextUri をキャンセルする', async () => {
    const cancel = vi.fn(async () => undefined);
    const client = {
      start: vi.fn(async () => ({ id: 'q1', nextUri: 'next-1', stats: { state: 'RUNNING' } })),
      advance: vi.fn(),
      cancel,
      waitBackoff: vi.fn(async () => undefined),
    } as unknown as StatementClient;

    const result = await driveStatementPages({
      client,
      statement: 'SELECT 1',
      ctx: { user: 'alice' },
      onPage: () => 'stop',
    });
    expect(result.completed).toBe(false);
    expect(cancel).toHaveBeenCalledWith('next-1', { user: 'alice' });
  });

  it('generator を閉じると残った nextUri をキャンセルする', async () => {
    const cancel = vi.fn(async () => undefined);
    const client = {
      start: vi.fn(async () => ({ id: 'q1', nextUri: 'next-1', stats: { state: 'RUNNING' } })),
      advance: vi.fn(),
      cancel,
      waitBackoff: vi.fn(async () => undefined),
    } as unknown as StatementClient;
    const pages = statementPages({ client, statement: 'SELECT 1', ctx: {} });

    await pages.next();
    await pages.return(undefined);

    expect(cancel).toHaveBeenCalledOnce();
  });

  it('空ページだけで backoff を増やし、データページでリセットする', async () => {
    const pages = [
      { id: 'q1', nextUri: 'next-2', stats: { state: 'RUNNING' } },
      { id: 'q1', nextUri: 'next-3', stats: { state: 'RUNNING' }, data: [[1]] },
      { id: 'q1', stats: { state: 'FINISHED' }, data: [[2]] },
    ];
    const waitBackoff = vi.fn(async (attempt: number, signal?: AbortSignal) => {
      void attempt;
      void signal;
    });
    const client = {
      start: vi.fn(async () => ({ id: 'q1', nextUri: 'next-1', stats: { state: 'QUEUED' } })),
      advance: vi.fn(async () => pages.shift()!),
      cancel: vi.fn(async () => undefined),
      waitBackoff,
    } as unknown as StatementClient;

    await driveStatementPages({ client, statement: 'SELECT 1', ctx: {}, onPage: () => undefined });

    expect(waitBackoff.mock.calls.map(([attempt]) => attempt)).toEqual([0, 1]);
  });

  it('observer が停止しても deadline で中断して残存クエリをキャンセルする', async () => {
    const cancel = vi.fn(async () => undefined);
    const client = {
      start: vi.fn(async () => ({ id: 'q1', nextUri: 'next-1', stats: { state: 'RUNNING' } })),
      advance: vi.fn(),
      cancel,
      waitBackoff: vi.fn(async () => undefined),
    } as unknown as StatementClient;

    await expect(
      driveStatementPages({
        client,
        statement: 'SELECT 1',
        ctx: {},
        timeoutMs: 5,
        onPage: () => new Promise<void>(() => undefined),
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledWith('next-1', {});
  });
});
