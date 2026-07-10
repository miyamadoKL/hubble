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
import type { ResultSearchPage } from '@hubble/contracts';
import { useServerResultView } from './useServerResultView';

const searchQueryRows = vi.hoisted(() => vi.fn());
vi.mock('../../execution/api', () => ({ searchQueryRows }));

/** フックの返り値を JSON で描画するテスト用コンポーネント。 */
function Probe({
  queryId,
  active,
  filter,
}: {
  queryId: string | undefined;
  active: boolean;
  filter: string;
}) {
  const view = useServerResultView(queryId, active, filter, null);
  return <pre data-testid="view">{JSON.stringify(view)}</pre>;
}

function page(rows: unknown[][], totalMatched: number): ResultSearchPage {
  return { offset: 0, rows, totalMatched, totalRows: 100, complete: true };
}

describe('useServerResultView', () => {
  let container: HTMLDivElement;
  let root: Root;

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
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  test('debounces and returns the search page', async () => {
    searchQueryRows.mockResolvedValue(page([['a']], 1));
    act(() => {
      root.render(<Probe queryId="q1" active filter="tokyo" />);
    });
    // デバウンス経過前はリクエストを送らない。
    expect(searchQueryRows).not.toHaveBeenCalled();
    expect(view().loading).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(300);
      // resolve 済み Promise の then を flush する。
      await vi.runAllTimersAsync();
    });
    expect(searchQueryRows).toHaveBeenCalledWith('q1', {
      search: 'tokyo',
      offset: 0,
      limit: 10_000,
    });
    expect(view()).toMatchObject({ rows: [['a']], totalMatched: 1, loading: false });
  });

  test('drops a stale response when the filter changes mid-flight', async () => {
    // 1 回目は遅延させ、2 回目のレスポンスの後に届くようにする。
    let resolveFirst: (value: ResultSearchPage) => void = () => {};
    searchQueryRows
      .mockImplementationOnce(
        () =>
          new Promise<ResultSearchPage>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(page([['second']], 1));
    act(() => {
      root.render(<Probe queryId="q1" active filter="first" />);
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    // filter を変更して 2 回目のリクエストを発火させる。
    act(() => {
      root.render(<Probe queryId="q1" active filter="second" />);
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();
    });
    // 遅れて届いた 1 回目のレスポンスは捨てられる。
    await act(async () => {
      resolveFirst(page([['first']], 1));
      await vi.runAllTimersAsync();
    });
    expect(view().rows).toEqual([['second']]);
  });

  test('resets to empty when inactive', async () => {
    searchQueryRows.mockResolvedValue(page([['a']], 1));
    act(() => {
      root.render(<Probe queryId="q1" active filter="tokyo" />);
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();
    });
    expect(view().rows).toEqual([['a']]);
    // 非アクティブに切り替えると即座に空へ戻り、追加リクエストも送らない。
    act(() => {
      root.render(<Probe queryId="q1" active={false} filter="tokyo" />);
    });
    expect(view()).toMatchObject({ rows: [], totalMatched: 0, loading: false });
    expect(searchQueryRows).toHaveBeenCalledTimes(1);
  });
});
