/**
 * ResultGrid の結果表示域の高さ調整ハンドル（pointer ドラッグ、ダブルクリックリセット、
 * localStorage 永続化）を検証する。列フィルタ/ソート等のロジックは ResultGrid.test.ts
 * （純粋関数のみ）で別途カバーしている。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { QueryColumn } from '@hubble/contracts';
import { ResultGrid } from './ResultGrid';
import {
  RESULT_HEIGHT_MIN,
  getResultHeight,
  resultHeightMax,
  resultHeightsStorageKey,
  setResultHeight,
} from '../../notebook/resultHeight';

const columns: QueryColumn[] = [
  { name: 'id', type: 'bigint' },
  { name: 'label', type: 'varchar' },
];
const rows = [
  [1, 'a'],
  [2, 'b'],
];

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

/**
 * ResizeObserverのモック実装。jsdomはResizeObserverを実装していないため、
 * 個々のテストで observe 呼び出し直後に指定した高さ（contentRect.height）で
 * コールバックを同期的に発火させる最小限のスタブを用意する。
 * install() は afterEach で元のResizeObserverへ戻すための復元関数を返す。
 */
function installResizeObserverStub(height: number): () => void {
  const original = globalThis.ResizeObserver;
  class StubResizeObserver {
    #callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.#callback = callback;
    }
    observe(target: Element): void {
      const entry = {
        target,
        contentRect: { height } as DOMRectReadOnly,
      } as ResizeObserverEntry;
      this.#callback([entry], this as unknown as ResizeObserver);
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
  return () => {
    globalThis.ResizeObserver = original;
  };
}

/** useServerResultView が無条件に useQuery を呼ぶため、常に QueryClientProvider で包む。 */
function renderGrid(props: React.ComponentProps<typeof ResultGrid>): void {
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ResultGrid {...props} />
      </QueryClientProvider>,
    );
  });
}

beforeEach(() => {
  localStorage.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
  container.remove();
  localStorage.clear();
});

/** clientY / pointerId を持つ擬似 PointerEvent を作る（jsdom は PointerEvent 未実装のため）。 */
function pointerEvent(type: string, coords: { clientY?: number; pointerId?: number }): Event {
  const event = new Event(type, { bubbles: true }) as PointerEvent;
  if (coords.clientY !== undefined)
    Object.defineProperty(event, 'clientY', { value: coords.clientY });
  if (coords.pointerId !== undefined)
    Object.defineProperty(event, 'pointerId', { value: coords.pointerId });
  return event;
}

function heightHandle(): HTMLElement {
  return container.querySelector('[aria-orientation="horizontal"]') as HTMLElement;
}

function scrollContainer(): HTMLElement {
  return container.querySelector('[data-testid="result-grid"]') as HTMLElement;
}

describe('ResultGrid height resize handle', () => {
  test('未調整時はmax-h-96クラスで、明示的なheightは付かない', () => {
    renderGrid({ columns, rows, notebookId: 'nb-1', cellId: 'cell-1' });
    const el = scrollContainer();
    expect(el.className).toContain('max-h-96');
    expect(el.style.height).toBe('');
  });

  test('ハンドルをドラッグすると明示的なheightが設定され、localStorageへ保存される', () => {
    renderGrid({ columns, rows, notebookId: 'nb-1', cellId: 'cell-1' });
    const handle = heightHandle();
    act(() => handle.dispatchEvent(pointerEvent('pointerdown', { clientY: 300 })));
    act(() => window.dispatchEvent(pointerEvent('pointermove', { clientY: 500 })));
    act(() => window.dispatchEvent(pointerEvent('pointerup', {})));

    const el = scrollContainer();
    expect(el.className).not.toContain('max-h-96');
    expect(el.style.height).not.toBe('');
    expect(getResultHeight('nb-1', 'cell-1')).not.toBeNull();
    expect(localStorage.getItem(resultHeightsStorageKey('nb-1'))).not.toBeNull();
  });

  test('ダブルクリックで未調整状態へ戻り、localStorageのエントリが解除される', () => {
    renderGrid({ columns, rows, notebookId: 'nb-1', cellId: 'cell-1' });
    const handle = heightHandle();
    act(() => handle.dispatchEvent(pointerEvent('pointerdown', { clientY: 300 })));
    act(() => window.dispatchEvent(pointerEvent('pointermove', { clientY: 500 })));
    act(() => window.dispatchEvent(pointerEvent('pointerup', {})));
    expect(getResultHeight('nb-1', 'cell-1')).not.toBeNull();

    act(() => handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    const el = scrollContainer();
    expect(el.className).toContain('max-h-96');
    expect(el.style.height).toBe('');
    expect(getResultHeight('nb-1', 'cell-1')).toBeNull();
  });

  test('notebookId/cellIdが無ければ永続化は行わないが、ドラッグ自体は効く', () => {
    renderGrid({ columns, rows });
    const handle = heightHandle();
    act(() => handle.dispatchEvent(pointerEvent('pointerdown', { clientY: 300 })));
    act(() => window.dispatchEvent(pointerEvent('pointermove', { clientY: 500 })));
    act(() => window.dispatchEvent(pointerEvent('pointerup', {})));

    const el = scrollContainer();
    expect(el.style.height).not.toBe('');
  });

  test('保存済みの負数はマウント時に下限へクランプされる', () => {
    setResultHeight('nb-1', 'cell-1', -500);
    renderGrid({ columns, rows, notebookId: 'nb-1', cellId: 'cell-1' });
    const el = scrollContainer();
    expect(el.style.height).toBe(`${RESULT_HEIGHT_MIN}px`);
  });

  test('保存済みの巨大な値はマウント時にビューポート依存の上限へクランプされる', () => {
    setResultHeight('nb-1', 'cell-1', 999999);
    renderGrid({ columns, rows, notebookId: 'nb-1', cellId: 'cell-1' });
    const el = scrollContainer();
    expect(el.style.height).toBe(`${resultHeightMax(window.innerHeight)}px`);
  });

  test('ResizeObserver非対応環境では、未調整時のaria-valuenowが下限にフォールバックする', () => {
    // jsdomはResizeObserverを実装していないため、モックを入れなければこの経路を検証できる。
    expect(typeof globalThis.ResizeObserver).toBe('undefined');
    renderGrid({ columns, rows, notebookId: 'nb-1', cellId: 'cell-1' });
    const handle = heightHandle();
    expect(handle.getAttribute('aria-valuenow')).toBe(String(RESULT_HEIGHT_MIN));
    expect(handle.getAttribute('aria-valuemax')).toBe(String(resultHeightMax(window.innerHeight)));
  });

  test('未調整時のaria-valuenowは、ResizeObserverが報告する実測高さに追従する', () => {
    const restore = installResizeObserverStub(384);
    try {
      renderGrid({ columns, rows, notebookId: 'nb-1', cellId: 'cell-1' });
      const handle = heightHandle();
      // customHeightが未調整（null）でも、実測高さ（384px、max-h-96の上限相当）が
      // 下限128px固定ではなく、そのまま aria-valuenow へ反映される。
      expect(handle.getAttribute('aria-valuenow')).toBe('384');
    } finally {
      restore();
    }
  });

  test('未調整時の矢印キー操作は、実測高さを基準に増減する', () => {
    const restore = installResizeObserverStub(200);
    try {
      renderGrid({ columns, rows, notebookId: 'nb-1', cellId: 'cell-1' });
      const handle = heightHandle();
      expect(handle.getAttribute('aria-valuenow')).toBe('200');

      const event = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true });
      act(() => handle.dispatchEvent(event));

      // 実測高さ200pxを起点に16px刻みで増分される（固定値128pxからの増分にはならない）。
      expect(handle.getAttribute('aria-valuenow')).toBe('216');
      expect(scrollContainer().style.height).toBe('216px');
    } finally {
      restore();
    }
  });

  test('ハンドルにtouch-actionを止めるクラスが付与されている', () => {
    renderGrid({ columns, rows, notebookId: 'nb-1', cellId: 'cell-1' });
    expect(heightHandle().className).toContain('touch-none');
  });

  // PR #119 では通常時ほぼ不可視（h-px の透明バー）だったため発見されなかった。
  // グリップは通常状態でも常時見えるスタイル（不透明な bg-border-base）でなければならない。
  test('グリップは通常状態でも常時見える（透明ではない）', () => {
    renderGrid({ columns, rows, notebookId: 'nb-1', cellId: 'cell-1' });
    const grip = heightHandle().querySelector('span');
    expect(grip?.className).toContain('bg-border-base');
    expect(grip?.className).not.toContain('bg-transparent');
  });

  // hover / focus-visible 時はアクセントカラーへ強調される（常時視認できる状態からの
  // さらなる強調）。実際の :hover は jsdom で再現できないため、クラスの付与のみ検証する。
  test('グリップはhover/focus時にアクセントカラーへ強調するクラスを持つ', () => {
    renderGrid({ columns, rows, notebookId: 'nb-1', cellId: 'cell-1' });
    const grip = heightHandle().querySelector('span');
    expect(grip?.className).toContain('group-hover:bg-accent');
    expect(grip?.className).toContain('group-focus-visible:bg-accent');
  });

  test('矢印キー操作はpreventDefaultされ、ページの矢印キースクロールと衝突しない', () => {
    renderGrid({ columns, rows, notebookId: 'nb-1', cellId: 'cell-1' });
    const handle = heightHandle();
    const event = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
      cancelable: true,
    });
    act(() => handle.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
  });

  test('pointercancelでドラッグが終了し、bodyのcursor/userSelectがリークしない', () => {
    renderGrid({ columns, rows, notebookId: 'nb-1', cellId: 'cell-1' });
    const handle = heightHandle();

    act(() => handle.dispatchEvent(pointerEvent('pointerdown', { clientY: 300, pointerId: 9 })));
    expect(document.body.style.cursor).toBe('row-resize');
    act(() => window.dispatchEvent(pointerEvent('pointermove', { clientY: 500, pointerId: 9 })));

    const el = scrollContainer();
    const heightAfterMove = el.style.height;
    expect(heightAfterMove).not.toBe('');

    act(() => window.dispatchEvent(pointerEvent('pointercancel', { pointerId: 9 })));
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');

    // cleanup済みなので、以降のpointermoveでは高さが変化しない。
    act(() => window.dispatchEvent(pointerEvent('pointermove', { clientY: 900, pointerId: 9 })));
    expect(scrollContainer().style.height).toBe(heightAfterMove);
  });

  test('ドラッグ中にコンポーネントがunmountされてもwindowのlistenerとbodyスタイルがリークしない', async () => {
    renderGrid({ columns, rows, notebookId: 'nb-1', cellId: 'cell-1' });
    const handle = heightHandle();

    act(() => handle.dispatchEvent(pointerEvent('pointerdown', { clientY: 300, pointerId: 5 })));
    expect(document.body.style.cursor).toBe('row-resize');

    await act(async () => root.unmount());

    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');

    // unmount後にpointermove/pointerupを送ってもエラーにならない（listenerが残っていない）。
    expect(() => {
      window.dispatchEvent(pointerEvent('pointermove', { clientY: 700, pointerId: 5 }));
      window.dispatchEvent(pointerEvent('pointerup', { pointerId: 5 }));
    }).not.toThrow();

    // 以降のafterEachでの再unmountに備えて新しいrootを張り直す。
    root = createRoot(container);
  });
});
