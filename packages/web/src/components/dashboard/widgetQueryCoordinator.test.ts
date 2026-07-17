// dashboard queryのdedupe、同時実行上限、cancelと失敗解放を検証する。
import type { SavedQuery } from '@hubble/contracts';
import { describe, expect, test, vi } from 'vitest';
import {
  DashboardQueryCoordinator,
  executeWidgetQuery,
  type SharedWidgetQueryState,
  type WidgetQueryApi,
} from './widgetQueryCoordinator';

const result = (queryName: string) => ({
  queryName,
  columns: [{ name: 'value', type: 'bigint' }],
  rows: [[1]],
});

describe('DashboardQueryCoordinator', () => {
  test('同じsavedQueryIdの購読は一つのquery実行を共有する', async () => {
    const execution = Promise.withResolvers<ReturnType<typeof result>>();
    const executor = vi.fn(() => execution.promise);
    const coordinator = new DashboardQueryCoordinator(4, executor);
    const first: SharedWidgetQueryState[] = [];
    const second: SharedWidgetQueryState[] = [];

    const unsubscribeFirst = coordinator.subscribe('saved-1', (state) => first.push(state));
    const unsubscribeSecond = coordinator.subscribe('saved-1', (state) => second.push(state));
    expect(executor).toHaveBeenCalledOnce();

    execution.resolve(result('Shared query'));
    await vi.waitFor(() => expect(first.at(-1)?.loading).toBe(false));

    expect(second.at(-1)).toEqual(first.at(-1));
    expect(first.at(-1)?.queryName).toBe('Shared query');
    unsubscribeFirst();
    unsubscribeSecond();
    coordinator.dispose();
  });

  test('異なるdashboard scopeのcoordinatorは同じsavedQueryIdを共有しない', async () => {
    const firstExecutor = vi.fn(() => Promise.resolve(result('First scope')));
    const secondExecutor = vi.fn(() => Promise.resolve(result('Second scope')));
    const firstCoordinator = new DashboardQueryCoordinator(1, firstExecutor);
    const secondCoordinator = new DashboardQueryCoordinator(1, secondExecutor);

    firstCoordinator.subscribe('saved-1', () => undefined);
    secondCoordinator.subscribe('saved-1', () => undefined);

    expect(firstExecutor).toHaveBeenCalledOnce();
    expect(secondExecutor).toHaveBeenCalledOnce();
    firstCoordinator.dispose();
    secondCoordinator.dispose();
  });

  test('dashboardの同時実行数を上限内に保つ', async () => {
    const executions = new Map<string, PromiseWithResolvers<ReturnType<typeof result>>>();
    let active = 0;
    let peak = 0;
    const executor = vi.fn((savedQueryId: string) => {
      active += 1;
      peak = Math.max(peak, active);
      const execution = Promise.withResolvers<ReturnType<typeof result>>();
      executions.set(savedQueryId, execution);
      return execution.promise.finally(() => {
        active -= 1;
      });
    });
    const coordinator = new DashboardQueryCoordinator(2, executor);
    const unsubscribes = ['a', 'b', 'c'].map((id) => coordinator.subscribe(id, () => undefined));

    expect(executor).toHaveBeenCalledTimes(2);
    executions.get('a')!.resolve(result('A'));
    await vi.waitFor(() => expect(executor).toHaveBeenCalledTimes(3));
    expect(peak).toBe(2);

    executions.get('b')!.resolve(result('B'));
    executions.get('c')!.resolve(result('C'));
    await vi.waitFor(() => expect(active).toBe(0));
    for (const unsubscribe of unsubscribes) unsubscribe();
    coordinator.dispose();
  });

  test('最後の購読解除でactive queryを中断する', async () => {
    let receivedSignal: AbortSignal | undefined;
    const executor = vi.fn((_id: string, signal: AbortSignal) => {
      receivedSignal = signal;
      return new Promise<ReturnType<typeof result>>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const coordinator = new DashboardQueryCoordinator(1, executor);
    const unsubscribe = coordinator.subscribe('saved-1', () => undefined);

    unsubscribe();

    expect(receivedSignal?.aborted).toBe(true);
    coordinator.dispose();
  });

  test('disposeでactive queryを中断し遅延結果を通知しない', async () => {
    const execution = Promise.withResolvers<ReturnType<typeof result>>();
    let receivedSignal: AbortSignal | undefined;
    const executor = vi.fn((_id: string, signal: AbortSignal) => {
      receivedSignal = signal;
      return execution.promise;
    });
    const coordinator = new DashboardQueryCoordinator(1, executor);
    const states: SharedWidgetQueryState[] = [];
    coordinator.subscribe('saved-1', (state) => states.push(state));

    coordinator.dispose();
    expect(receivedSignal?.aborted).toBe(true);
    execution.resolve(result('Late result'));
    await execution.promise;
    await Promise.resolve();
    expect(states.some((state) => state.queryName === 'Late result')).toBe(false);
  });

  test('失敗した実行が枠を解放して次のqueued queryを開始する', async () => {
    const first = Promise.withResolvers<ReturnType<typeof result>>();
    const second = Promise.withResolvers<ReturnType<typeof result>>();
    const executor = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const coordinator = new DashboardQueryCoordinator(1, executor);
    const states: SharedWidgetQueryState[] = [];
    coordinator.subscribe('a', (state) => states.push(state));
    coordinator.subscribe('b', () => undefined);

    first.reject(new Error('poll failed'));
    await vi.waitFor(() => expect(executor).toHaveBeenCalledTimes(2));

    expect(states.at(-1)?.error).toBe('poll failed');
    second.resolve(result('B'));
    coordinator.dispose();
  });

  test('refreshは共有queryを一度だけ再実行する', async () => {
    const first = Promise.withResolvers<ReturnType<typeof result>>();
    const second = Promise.withResolvers<ReturnType<typeof result>>();
    const executor = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const coordinator = new DashboardQueryCoordinator(1, executor);
    const states: SharedWidgetQueryState[] = [];
    coordinator.subscribe('saved-1', (state) => states.push(state));

    first.resolve(result('First run'));
    await vi.waitFor(() => expect(states.at(-1)?.loading).toBe(false));
    coordinator.refresh('saved-1');
    await vi.waitFor(() => expect(executor).toHaveBeenCalledTimes(2));

    expect(states.at(-1)?.loading).toBe(true);
    second.resolve(result('Second run'));
    await vi.waitFor(() => expect(states.at(-1)?.queryName).toBe('Second run'));
    coordinator.dispose();
  });

  test('queryName取得前のrefreshも初回実行を中断して再実行する', async () => {
    const second = Promise.withResolvers<ReturnType<typeof result>>();
    let firstSignal: AbortSignal | undefined;
    const executor = vi.fn((_id: string, signal: AbortSignal) => {
      if (executor.mock.calls.length === 1) {
        firstSignal = signal;
        return new Promise<ReturnType<typeof result>>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      return second.promise;
    });
    const coordinator = new DashboardQueryCoordinator(1, executor);
    const states: SharedWidgetQueryState[] = [];
    coordinator.subscribe('saved-1', (state) => states.push(state));

    await vi.waitFor(() => expect(executor).toHaveBeenCalledOnce());
    coordinator.refresh('saved-1');
    await vi.waitFor(() => expect(executor).toHaveBeenCalledTimes(2));

    expect(firstSignal?.aborted).toBe(true);
    second.resolve(result('Second run'));
    await vi.waitFor(() => expect(states.at(-1)?.queryName).toBe('Second run'));
    expect(states.some((state) => state.queryName === 'First run')).toBe(false);
    coordinator.dispose();
  });

  test('queued queryのrefreshは再実行を二重に追加しない', async () => {
    const first = Promise.withResolvers<ReturnType<typeof result>>();
    const second = Promise.withResolvers<ReturnType<typeof result>>();
    const executor = vi.fn((savedQueryId: string) =>
      savedQueryId === 'first' ? first.promise : second.promise,
    );
    const coordinator = new DashboardQueryCoordinator(1, executor);
    coordinator.subscribe('first', () => undefined);
    coordinator.subscribe('second', () => undefined);

    await vi.waitFor(() => expect(executor).toHaveBeenCalledOnce());
    coordinator.refresh('second');
    first.resolve(result('First run'));
    await vi.waitFor(() => expect(executor).toHaveBeenCalledTimes(2));
    expect(executor.mock.calls.map(([savedQueryId]) => savedQueryId)).toEqual(['first', 'second']);
    second.resolve(result('Second run'));
    await vi.waitFor(() => expect(executor).toHaveBeenCalledTimes(2));
    coordinator.dispose();
  });

  test('error cacheの再購読はqueryを再実行しない', async () => {
    const executor = vi.fn(async () => {
      throw new Error('cached failure');
    });
    const coordinator = new DashboardQueryCoordinator(1, executor);
    const firstStates: SharedWidgetQueryState[] = [];
    const unsubscribeFirst = coordinator.subscribe('saved-error', (state) =>
      firstStates.push(state),
    );

    await vi.waitFor(() => expect(firstStates.at(-1)?.error).toBe('cached failure'));
    unsubscribeFirst();

    const secondStates: SharedWidgetQueryState[] = [];
    const unsubscribeSecond = coordinator.subscribe('saved-error', (state) =>
      secondStates.push(state),
    );
    expect(executor).toHaveBeenCalledOnce();
    expect(secondStates.at(-1)).toMatchObject({ loading: false, error: 'cached failure' });
    unsubscribeSecond();
    coordinator.dispose();
  });

  test('保存query名を実行中と失敗後の共有stateへ保持する', async () => {
    const execution = Promise.withResolvers<ReturnType<typeof result>>();
    const executor = vi.fn(
      (_id: string, _signal: AbortSignal, onQueryName?: (queryName: string) => void) => {
        onQueryName?.('Resolved title');
        return execution.promise;
      },
    );
    const coordinator = new DashboardQueryCoordinator(1, executor);
    const states: SharedWidgetQueryState[] = [];
    coordinator.subscribe('saved-title', (state) => states.push(state));

    expect(states.at(-1)).toMatchObject({ loading: true, queryName: 'Resolved title' });
    execution.reject(new Error('execution failed'));
    await vi.waitFor(() => expect(states.at(-1)?.error).toBe('execution failed'));
    expect(states.at(-1)?.queryName).toBe('Resolved title');
    coordinator.dispose();
  });
});

describe('executeWidgetQuery', () => {
  test('polling失敗時にactive queryをcancelして元エラーを返す', async () => {
    const savedQuery: SavedQuery = {
      id: 'saved-1',
      name: 'Saved query',
      description: '',
      statement: 'SELECT 1',
      isFavorite: false,
      createdAt: '2026-07-12T00:00:00.000Z',
      updatedAt: '2026-07-12T00:00:00.000Z',
    };
    const pollingError = new Error('snapshot unavailable');
    const cancel = vi.fn(async () => undefined);
    const api: WidgetQueryApi = {
      getSavedQuery: async () => savedQuery,
      createQuery: async () => ({ queryId: 'query-1' }),
      fetchQuerySnapshot: async () => {
        throw pollingError;
      },
      fetchQueryRows: async () => ({ offset: 0, rows: [], totalBuffered: 0, complete: true }),
      cancelQuery: cancel,
      now: () => 0,
      wait: async () => undefined,
    };

    await expect(executeWidgetQuery('saved-1', new AbortController().signal, api)).rejects.toBe(
      pollingError,
    );
    expect(cancel).toHaveBeenCalledWith('query-1');
  });

  test('unmount abortはpolling待機中でもactive queryを直ちにcancelする', async () => {
    const cancel = vi.fn(async () => undefined);
    const fetchSnapshot = vi.fn((_queryId: string, signal?: AbortSignal) => {
      return new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const api: WidgetQueryApi = {
      getSavedQuery: async () => ({
        id: 'saved-1',
        name: 'Saved query',
        description: '',
        statement: 'SELECT 1',
        isFavorite: false,
        createdAt: '2026-07-12T00:00:00.000Z',
        updatedAt: '2026-07-12T00:00:00.000Z',
      }),
      createQuery: async () => ({ queryId: 'query-1' }),
      fetchQuerySnapshot: fetchSnapshot,
      fetchQueryRows: async () => ({ offset: 0, rows: [], totalBuffered: 0, complete: true }),
      cancelQuery: cancel,
      now: () => 0,
      wait: async () => undefined,
    };
    const controller = new AbortController();
    const execution = executeWidgetQuery('saved-1', controller.signal, api);
    await vi.waitFor(() =>
      expect(fetchSnapshot).toHaveBeenCalledWith('query-1', controller.signal),
    );

    controller.abort();
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith('query-1'));

    await expect(execution).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledOnce();
  });

  test('cancel完了までexecutorをsettleせず元エラーを維持する', async () => {
    const pollingError = new Error('snapshot unavailable');
    const canceling = Promise.withResolvers<void>();
    const cancel = vi.fn(() => canceling.promise);
    const api: WidgetQueryApi = {
      getSavedQuery: async () => ({
        id: 'saved-1',
        name: 'Saved query',
        description: '',
        statement: 'SELECT 1',
        isFavorite: false,
        createdAt: '2026-07-12T00:00:00.000Z',
        updatedAt: '2026-07-12T00:00:00.000Z',
      }),
      createQuery: async () => ({ queryId: 'query-1' }),
      fetchQuerySnapshot: async () => {
        throw pollingError;
      },
      fetchQueryRows: async () => ({ offset: 0, rows: [], totalBuffered: 0, complete: true }),
      cancelQuery: cancel,
      now: () => 0,
      wait: async () => undefined,
    };

    const execution = executeWidgetQuery('saved-1', new AbortController().signal, api);
    let settled = false;
    void execution.catch(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(settled).toBe(false);

    canceling.resolve();
    await expect(execution).rejects.toBe(pollingError);
  });

  test('create応答待ちのabort後もqueryIdを受け取ってcancelする', async () => {
    const creating = Promise.withResolvers<{ queryId: string }>();
    const create = vi.fn(() => creating.promise);
    const cancel = vi.fn(async () => undefined);
    const api: WidgetQueryApi = {
      getSavedQuery: async () => ({
        id: 'saved-1',
        name: 'Saved query',
        description: '',
        statement: 'SELECT 1',
        isFavorite: false,
        createdAt: '2026-07-12T00:00:00.000Z',
        updatedAt: '2026-07-12T00:00:00.000Z',
      }),
      createQuery: create,
      fetchQuerySnapshot: vi.fn(),
      fetchQueryRows: vi.fn(),
      cancelQuery: cancel,
      now: () => 0,
      wait: async () => undefined,
    };
    const controller = new AbortController();
    const execution = executeWidgetQuery('saved-1', controller.signal, api);
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());

    controller.abort();
    expect(cancel).not.toHaveBeenCalled();
    creating.resolve({ queryId: 'query-after-abort' });

    await expect(execution).rejects.toMatchObject({ name: 'AbortError' });
    expect(create.mock.calls[0]).toHaveLength(1);
    expect(cancel).toHaveBeenCalledWith('query-after-abort');
  });
});
