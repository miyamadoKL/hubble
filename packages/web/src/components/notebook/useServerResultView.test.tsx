/**
 * useServerResultView のテスト。
 *
 * searchQueryRows をモック化し、デバウンス、世代管理（古いレスポンスの破棄）、
 * 非アクティブ時のリセットを確認する。フックの返り値は DOM へ JSON として
 * 描画し、textContent 経由で検証する。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ResultSearchPage, ResultSort } from '@hubble/contracts';
import { useServerResultView } from './useServerResultView';

const searchQueryRows = vi.hoisted(() => vi.fn());
vi.mock('../../execution/api', () => ({ searchQueryRows }));

/** フックの返り値を JSON で描画するテスト用コンポーネント。 */
function Probe({
  queryId,
  active,
  filter,
  sort = null,
}: {
  queryId: string | undefined;
  active: boolean;
  filter: string;
  sort?: ResultSort | null;
}) {
  const view = useServerResultView(queryId, active, filter, sort);
  return <pre data-testid="view">{JSON.stringify(view)}</pre>;
}

function page(rows: unknown[][], totalMatched: number): ResultSearchPage {
  return { offset: 0, rows, totalMatched, totalRows: 100, complete: true };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('useServerResultView', () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  /** 直近レンダーのフック返り値を DOM から読み取る。 */
  const view = () => {
    const text = container.querySelector('[data-testid="view"]')?.textContent ?? '{}';
    return JSON.parse(text) as {
      rows: unknown[][];
      totalMatched: number;
      loading: boolean;
      error?: string;
    };
  };

  beforeEach(() => {
    vi.useFakeTimers();
    searchQueryRows.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    container.remove();
    vi.useRealTimers();
  });

  function renderProbe(props: React.ComponentProps<typeof Probe>): void {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Probe {...props} />
        </QueryClientProvider>,
      );
    });
  }

  test('debounces and returns the search page', async () => {
    searchQueryRows.mockResolvedValue(page([['a']], 1));
    renderProbe({
      queryId: 'q1',
      active: true,
      filter: ' tokyo ',
      sort: { columnIndex: 2, dir: 'desc' },
    });
    // デバウンス経過前はリクエストを送らない。
    expect(searchQueryRows).not.toHaveBeenCalled();
    expect(view().loading).toBe(true);
    act(() => vi.advanceTimersByTime(299));
    expect(searchQueryRows).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1);
      // resolve 済み Promise の then を flush する。
      await vi.runAllTimersAsync();
    });
    expect(searchQueryRows).toHaveBeenCalledWith(
      'q1',
      {
        search: 'tokyo',
        sort: { columnIndex: 2, dir: 'desc' },
        offset: 0,
        limit: 10_000,
      },
      expect.any(AbortSignal),
    );
    expect(view()).toMatchObject({ rows: [['a']], totalMatched: 1, loading: false });
  });

  test('drops a stale response when the filter changes mid-flight', async () => {
    // 1 回目は遅延させ、2 回目のレスポンスの後に届くようにする。
    const first = deferred<ResultSearchPage>();
    let firstSignal: AbortSignal | undefined;
    searchQueryRows
      .mockImplementationOnce((_queryId: string, _request: unknown, signal: AbortSignal) => {
        firstSignal = signal;
        return first.promise;
      })
      .mockResolvedValueOnce(page([['second']], 1));
    renderProbe({ queryId: 'q1', active: true, filter: 'first' });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    // filter を変更して 2 回目のリクエストを発火させる。
    renderProbe({ queryId: 'q1', active: true, filter: 'second' });
    expect(firstSignal?.aborted).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();
    });
    // 遅れて届いた 1 回目のレスポンスは捨てられる。
    await act(async () => {
      first.resolve(page([['first']], 1));
      await vi.runAllTimersAsync();
    });
    expect(view().rows).toEqual([['second']]);
  });

  test('keeps previous rows visible while the next condition is fetching', async () => {
    const second = deferred<ResultSearchPage>();
    searchQueryRows.mockResolvedValueOnce(page([['first']], 1)).mockReturnValueOnce(second.promise);
    renderProbe({ queryId: 'q1', active: true, filter: 'first' });
    await act(async () => {
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();
    });
    renderProbe({ queryId: 'q1', active: true, filter: 'second' });
    expect(view()).toMatchObject({ rows: [['first']], totalMatched: 1, loading: true });

    await act(async () => {
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();
    });
    expect(searchQueryRows).toHaveBeenCalledTimes(2);
    await act(async () => {
      second.resolve(page([['second']], 1));
      await vi.runAllTimersAsync();
      await Promise.resolve();
    });
    expect(view()).toMatchObject({ rows: [['second']], totalMatched: 1, loading: false });
  });

  test('cancels a pending debounce before invoking the latest condition', async () => {
    const latest = deferred<ResultSearchPage>();
    searchQueryRows.mockReturnValueOnce(latest.promise);
    renderProbe({ queryId: 'q1', active: true, filter: 'first' });
    act(() => vi.advanceTimersByTime(299));
    renderProbe({ queryId: 'q1', active: true, filter: 'latest' });
    expect(searchQueryRows).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(299));
    expect(searchQueryRows).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1);
      await vi.runAllTimersAsync();
    });
    expect(searchQueryRows).toHaveBeenCalledTimes(1);
    expect(searchQueryRows).toHaveBeenCalledWith(
      'q1',
      { search: 'latest', offset: 0, limit: 10_000 },
      expect.any(AbortSignal),
    );

    await act(async () => {
      latest.resolve(page([['latest']], 1));
      await vi.runAllTimersAsync();
      await Promise.resolve();
    });
    expect(view()).toMatchObject({ rows: [['latest']], totalMatched: 1, loading: false });
  });

  test('aborts an in-flight search when the component unmounts', async () => {
    let signal: AbortSignal | undefined;
    searchQueryRows.mockImplementation(
      (_queryId: string, _request: unknown, requestSignal: AbortSignal) => {
        signal = requestSignal;
        return new Promise<ResultSearchPage>(() => {});
      },
    );
    renderProbe({ queryId: 'q1', active: true, filter: 'tokyo' });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(signal?.aborted).toBe(false);
    act(() => root.unmount());
    expect(signal?.aborted).toBe(true);
  });

  test.each([
    ['active=false', { queryId: 'q1', active: false }],
    ['queryId=undefined', { queryId: undefined, active: true }],
  ] as const)('aborts an in-flight search when %s', async (_case, nextProps) => {
    let signal: AbortSignal | undefined;
    searchQueryRows.mockImplementation(
      (_queryId: string, _request: unknown, requestSignal: AbortSignal) => {
        signal = requestSignal;
        return new Promise<ResultSearchPage>(() => {});
      },
    );
    renderProbe({ queryId: 'q1', active: true, filter: 'tokyo' });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(signal?.aborted).toBe(false);

    renderProbe({ ...nextProps, filter: 'tokyo' });
    expect(signal?.aborted).toBe(true);
    expect(view()).toMatchObject({ rows: [], totalMatched: 0, loading: false });
    expect(searchQueryRows).toHaveBeenCalledTimes(1);
  });

  test('resets to empty when inactive', async () => {
    searchQueryRows.mockResolvedValue(page([['a']], 1));
    renderProbe({ queryId: 'q1', active: true, filter: 'tokyo' });
    await act(async () => {
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();
    });
    expect(view().rows).toEqual([['a']]);
    // 非アクティブに切り替えると即座に空へ戻り、追加リクエストも送らない。
    renderProbe({ queryId: 'q1', active: false, filter: 'tokyo' });
    expect(view()).toMatchObject({ rows: [], totalMatched: 0, loading: false });
    expect(searchQueryRows).toHaveBeenCalledTimes(1);
  });

  test('does not fetch without a query id', () => {
    renderProbe({ queryId: undefined, active: true, filter: 'tokyo' });
    expect(view()).toMatchObject({ rows: [], totalMatched: 0, loading: false });
    expect(searchQueryRows).not.toHaveBeenCalled();
  });

  test('shows an error without retrying', async () => {
    searchQueryRows.mockRejectedValue(new Error('search failed'));
    renderProbe({ queryId: 'q1', active: true, filter: 'tokyo' });
    await act(async () => {
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();
    });
    expect(view()).toMatchObject({
      rows: [],
      totalMatched: 0,
      loading: false,
      error: 'search failed',
    });
    expect(searchQueryRows).toHaveBeenCalledTimes(1);
  });
});
