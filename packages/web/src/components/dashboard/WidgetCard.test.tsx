// query widgetがviewportへ入るまで共有query購読を開始しないことを検証する。
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { QueryWidget } from '@hubble/contracts';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { useDashboardWidgetData } = vi.hoisted(() => ({
  useDashboardWidgetData: vi.fn(() => ({
    loading: true,
    error: null,
    columns: [],
    rows: [],
    queryName: null,
    refresh: vi.fn(),
  })),
}));

vi.mock('./DashboardWidgetData', () => ({ useDashboardWidgetData }));

import { WidgetCard } from './WidgetCard';

describe('WidgetCard viewport activation', () => {
  let callback: IntersectionObserverCallback;
  const disconnect = vi.fn();

  beforeEach(() => {
    useDashboardWidgetData.mockClear();
    disconnect.mockClear();
    class FakeIntersectionObserver {
      constructor(next: IntersectionObserverCallback) {
        callback = next;
      }
      observe() {}
      disconnect() {
        disconnect();
      }
    }
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('viewport外では無効で、交差後だけquery購読を有効にする', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const widget: QueryWidget = {
      id: 'widget-1',
      kind: 'query',
      position: { col: 0, row: 0, sizeX: 2, sizeY: 2 },
      savedQueryId: 'saved-1',
      viz: 'table',
    };

    act(() => root.render(<WidgetCard widget={widget} editing={false} onRemove={vi.fn()} />));
    expect(useDashboardWidgetData).toHaveBeenLastCalledWith('saved-1', false);

    act(() => {
      callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    });
    expect(useDashboardWidgetData).toHaveBeenLastCalledWith('saved-1', true);

    act(() => {
      callback(
        [{ isIntersecting: false } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    });
    expect(useDashboardWidgetData).toHaveBeenLastCalledWith('saved-1', true);

    act(() => root.unmount());
    expect(disconnect).toHaveBeenCalledOnce();
    container.remove();
  });
});
