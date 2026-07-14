// EXPLAIN副問い合わせの世代、キャンセル、終端所有権を検証する。
import type { CreateQueryRequest, QueryEvent, QueryRowsPage } from '@hubble/contracts';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { SseHandlers, SseSubscription } from '../../execution/sse';
import {
  ExplainQueryLifecycle,
  type ExplainLifecycleCallbacks,
  type ExplainLifecycleDependencies,
} from './explainLifecycle';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const request = (statement: string): CreateQueryRequest => ({ statement });
const page = (text: string): QueryRowsPage => ({
  offset: 0,
  rows: [[text]],
  totalBuffered: 1,
  complete: true,
});
const createQuery = vi.fn(
  async (requestValue: CreateQueryRequest): Promise<{ queryId: string }> => {
    void requestValue;
    return { queryId: 'query' };
  },
);
const cancelQuery = vi.fn(async (queryId: string): Promise<void> => {
  void queryId;
});
const fetchQueryRows = vi.fn(
  async (queryId: string, offset: number, limit: number): Promise<QueryRowsPage> => {
    void queryId;
    void offset;
    void limit;
    return page('');
  },
);

describe('ExplainQueryLifecycle', () => {
  let subscriptions: Map<string, { handlers: SseHandlers; close: ReturnType<typeof vi.fn> }>;
  let dependencies: ExplainLifecycleDependencies;
  let running: boolean;
  let text: string | undefined;
  let callbacks: ExplainLifecycleCallbacks;

  beforeEach(() => {
    createQuery.mockReset();
    cancelQuery.mockReset().mockResolvedValue(undefined);
    fetchQueryRows.mockReset();
    subscriptions = new Map();
    dependencies = {
      createQuery,
      cancelQuery,
      fetchQueryRows,
      subscribeQueryEvents: (queryId, handlers): SseSubscription => {
        const close = vi.fn();
        subscriptions.set(queryId, { handlers, close });
        return { close };
      },
    };
    running = false;
    text = undefined;
    callbacks = {
      setRunning: (next) => {
        running = next;
      },
      setText: (next) => {
        text = next;
      },
    };
  });

  test('編集でcreate待機中の旧queryを失効させ、queryId確定後にcancelする', async () => {
    const pending = Promise.withResolvers<{ queryId: string }>();
    createQuery.mockReturnValue(pending.promise);
    const lifecycle = new ExplainQueryLifecycle(dependencies);

    lifecycle.start(request('EXPLAIN SELECT * FROM old_table'), callbacks);
    lifecycle.cancelCurrent();
    running = false;
    pending.resolve({ queryId: 'old-query' });
    await flush();

    expect(cancelQuery).toHaveBeenCalledWith('old-query');
    expect(subscriptions.has('old-query')).toBe(false);
    expect(running).toBe(false);
    expect(text).toBeUndefined();
  });

  test('再実行は旧queryをcancelし、旧イベントで新しいplanを上書きしない', async () => {
    createQuery
      .mockResolvedValueOnce({ queryId: 'old-query' })
      .mockResolvedValueOnce({ queryId: 'new-query' });
    fetchQueryRows.mockImplementation(async (queryId: string) => page(`${queryId} plan`));
    const lifecycle = new ExplainQueryLifecycle(dependencies);

    lifecycle.start(request('EXPLAIN SELECT * FROM old_table'), callbacks);
    await flush();
    const oldSubscription = subscriptions.get('old-query')!;
    lifecycle.start(request('EXPLAIN SELECT * FROM new_table'), callbacks);
    await flush();
    const newSubscription = subscriptions.get('new-query')!;

    oldSubscription.handlers.onEvent({
      type: 'error',
      error: { code: 'OLD', message: 'old failure' },
    });
    newSubscription.handlers.onEvent({
      type: 'done',
      state: 'finished',
      rowCount: 1,
      truncated: false,
    });
    await flush();

    expect(oldSubscription.close).toHaveBeenCalledOnce();
    expect(cancelQuery).toHaveBeenCalledWith('old-query');
    expect(text).toBe('new-query plan');
    expect(running).toBe(false);
  });

  test('削除後はdoneに続く行取得の遅延応答を反映しない', async () => {
    const rows = Promise.withResolvers<QueryRowsPage>();
    createQuery.mockResolvedValue({ queryId: 'deleted-query' });
    fetchQueryRows.mockReturnValue(rows.promise);
    const lifecycle = new ExplainQueryLifecycle(dependencies);
    lifecycle.start(request('EXPLAIN SELECT * FROM deleted_table'), callbacks);
    await flush();

    subscriptions.get('deleted-query')!.handlers.onEvent({
      type: 'done',
      state: 'finished',
      rowCount: 1,
      truncated: false,
    });
    lifecycle.cancelCurrent();
    running = false;
    rows.resolve(page('deleted plan'));
    await flush();

    expect(cancelQuery).toHaveBeenCalledWith('deleted-query');
    expect(text).toBeUndefined();
    expect(running).toBe(false);
  });

  test('unmountは購読とremote queryを一度だけ解放し、以後のイベントを無視する', async () => {
    createQuery.mockResolvedValue({ queryId: 'unmounted-query' });
    const lifecycle = new ExplainQueryLifecycle(dependencies);
    lifecycle.start(request('EXPLAIN SELECT * FROM unmounted_table'), callbacks);
    await flush();
    const subscription = subscriptions.get('unmounted-query')!;

    lifecycle.dispose();
    lifecycle.dispose();
    subscription.handlers.onEvent({
      type: 'error',
      error: { code: 'LATE', message: 'late failure' },
    } as QueryEvent);

    expect(subscription.close).toHaveBeenCalledOnce();
    expect(cancelQuery).toHaveBeenCalledOnce();
    expect(cancelQuery).toHaveBeenCalledWith('unmounted-query');
    expect(text).toBeUndefined();
  });

  test('終端イベントを一度だけsettleし、後続イベントを反映しない', async () => {
    createQuery.mockResolvedValue({ queryId: 'failed-query' });
    const setRunning = vi.fn(callbacks.setRunning);
    const setText = vi.fn(callbacks.setText);
    const lifecycle = new ExplainQueryLifecycle(dependencies);
    lifecycle.start(request('EXPLAIN SELECT missing'), { setRunning, setText });
    await flush();
    const handlers = subscriptions.get('failed-query')!.handlers;

    handlers.onEvent({
      type: 'error',
      error: { code: 'TRINO_ERROR', message: 'table missing' },
    });
    handlers.onEvent({
      type: 'done',
      state: 'failed',
      rowCount: 0,
      truncated: false,
    });

    expect(setRunning.mock.calls).toEqual([[true], [false]]);
    expect(setText.mock.calls).toEqual([[undefined], ['-- table missing']]);
    expect(fetchQueryRows).not.toHaveBeenCalled();
  });
});
