/**
 * ノートブック列幅リサイズハンドル（NotebookWidthFrame）の pointer ドラッグ、
 * ダブルクリックリセット、localStorage 永続化を検証する。
 */
import { useState } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { NotebookWidthFrame } from './NotebookView';
import {
  NOTEBOOK_WIDTH_DEFAULT,
  NOTEBOOK_WIDTH_STORAGE_KEY,
  clampNotebookWidth,
  readNotebookWidth,
  writeNotebookWidth,
} from '../../notebook/notebookWidth';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.clear();
});

/** clientX / clientY / pointerId を持つ擬似 PointerEvent を作る（jsdom は PointerEvent 未実装のため）。 */
function pointerEvent(
  type: string,
  coords: { clientX?: number; clientY?: number; pointerId?: number },
): Event {
  const event = new Event(type, { bubbles: true }) as PointerEvent;
  if (coords.clientX !== undefined)
    Object.defineProperty(event, 'clientX', { value: coords.clientX });
  if (coords.clientY !== undefined)
    Object.defineProperty(event, 'clientY', { value: coords.clientY });
  if (coords.pointerId !== undefined)
    Object.defineProperty(event, 'pointerId', { value: coords.pointerId });
  return event;
}

/** setWidth/resetWidth を localStorage 永続化つきの本物の state として持つテスト用ハーネス。 */
function Harness() {
  const [width, setWidthState] = useState(() => clampNotebookWidth(readNotebookWidth(), 2000));
  const setWidth = (next: number) => {
    const clamped = clampNotebookWidth(next, 2000);
    setWidthState(clamped);
    writeNotebookWidth(clamped);
  };
  return (
    <NotebookWidthFrame
      width={width}
      setWidth={setWidth}
      resetWidth={() => setWidth(NOTEBOOK_WIDTH_DEFAULT)}
      padding="px-6 py-6"
    >
      <div data-testid="content">content</div>
    </NotebookWidthFrame>
  );
}

describe('NotebookWidthFrame', () => {
  test('右ハンドルをドラッグすると移動量の2倍だけ幅が広がり、localStorageへ保存される', () => {
    act(() => root.render(<Harness />));

    const outer = container.firstElementChild as HTMLElement;
    expect(outer.style.maxWidth).toBe(`${NOTEBOOK_WIDTH_DEFAULT}px`);

    const rightHandle = container.querySelectorAll('[role="separator"]')[1] as HTMLElement;
    act(() => rightHandle.dispatchEvent(pointerEvent('pointerdown', { clientX: 500 })));
    act(() => window.dispatchEvent(pointerEvent('pointermove', { clientX: 600 })));
    act(() => window.dispatchEvent(pointerEvent('pointerup', {})));

    expect(outer.style.maxWidth).toBe(`${NOTEBOOK_WIDTH_DEFAULT + 200}px`);
    expect(localStorage.getItem(NOTEBOOK_WIDTH_STORAGE_KEY)).toBe(
      String(NOTEBOOK_WIDTH_DEFAULT + 200),
    );
  });

  test('左ハンドルを左へドラッグすると移動量の2倍だけ幅が広がる（対称に広がる）', () => {
    act(() => root.render(<Harness />));

    const outer = container.firstElementChild as HTMLElement;
    const leftHandle = container.querySelectorAll('[role="separator"]')[0] as HTMLElement;
    act(() => leftHandle.dispatchEvent(pointerEvent('pointerdown', { clientX: 500 })));
    act(() => window.dispatchEvent(pointerEvent('pointermove', { clientX: 400 })));
    act(() => window.dispatchEvent(pointerEvent('pointerup', {})));

    expect(outer.style.maxWidth).toBe(`${NOTEBOOK_WIDTH_DEFAULT + 200}px`);
  });

  test('ダブルクリックで既定幅へ戻り、localStorageへ保存される', () => {
    act(() => root.render(<Harness />));
    const outer = container.firstElementChild as HTMLElement;
    const rightHandle = container.querySelectorAll('[role="separator"]')[1] as HTMLElement;

    act(() => rightHandle.dispatchEvent(pointerEvent('pointerdown', { clientX: 500 })));
    act(() => window.dispatchEvent(pointerEvent('pointermove', { clientX: 700 })));
    act(() => window.dispatchEvent(pointerEvent('pointerup', {})));
    expect(outer.style.maxWidth).not.toBe(`${NOTEBOOK_WIDTH_DEFAULT}px`);

    act(() => rightHandle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(outer.style.maxWidth).toBe(`${NOTEBOOK_WIDTH_DEFAULT}px`);
    expect(localStorage.getItem(NOTEBOOK_WIDTH_STORAGE_KEY)).toBe(String(NOTEBOOK_WIDTH_DEFAULT));
  });

  test('矢印キーで16px刻みに調整できる', () => {
    const setWidth = vi.fn();
    act(() =>
      root.render(
        <NotebookWidthFrame
          width={900}
          setWidth={setWidth}
          resetWidth={() => {}}
          padding="px-6 py-6"
        >
          <div>content</div>
        </NotebookWidthFrame>,
      ),
    );
    const rightHandle = container.querySelectorAll('[role="separator"]')[1] as HTMLElement;
    act(() => {
      rightHandle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(setWidth).toHaveBeenCalledWith(916);
  });

  test('矢印キー操作はpreventDefaultされ、ページの矢印キースクロールと衝突しない', () => {
    act(() =>
      root.render(
        <NotebookWidthFrame width={900} setWidth={() => {}} resetWidth={() => {}} padding="p-0">
          <div>content</div>
        </NotebookWidthFrame>,
      ),
    );
    const rightHandle = container.querySelectorAll('[role="separator"]')[1] as HTMLElement;
    const event = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      rightHandle.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
  });

  test('ハンドルにtouch-actionを止めるクラスが付与されている', () => {
    act(() =>
      root.render(
        <NotebookWidthFrame width={900} setWidth={() => {}} resetWidth={() => {}} padding="p-0">
          <div>content</div>
        </NotebookWidthFrame>,
      ),
    );
    const handles = container.querySelectorAll('[role="separator"]');
    for (const handle of handles) {
      expect((handle as HTMLElement).className).toContain('touch-none');
    }
  });

  test('aria-valuemin/max/nowが現在の幅と許容範囲を反映する', () => {
    act(() =>
      root.render(
        <NotebookWidthFrame width={900} setWidth={() => {}} resetWidth={() => {}} padding="p-0">
          <div>content</div>
        </NotebookWidthFrame>,
      ),
    );
    const rightHandle = container.querySelectorAll('[role="separator"]')[1] as HTMLElement;
    expect(rightHandle.getAttribute('aria-valuenow')).toBe('900');
    expect(rightHandle.getAttribute('aria-valuemin')).toBe('672');
    // jsdomのデフォルトビューポート幅(1024px)から margin(32px) を引いた 992px が上限になる
    // （絶対上限1600pxより小さいため）。
    expect(rightHandle.getAttribute('aria-valuemax')).toBe(String(window.innerWidth - 32));
  });

  test('pointercancelでドラッグが終了し、bodyのcursor/userSelectがリークしない', () => {
    act(() => root.render(<Harness />));
    const outer = container.firstElementChild as HTMLElement;
    const rightHandle = container.querySelectorAll('[role="separator"]')[1] as HTMLElement;

    act(() =>
      rightHandle.dispatchEvent(pointerEvent('pointerdown', { clientX: 500, pointerId: 7 })),
    );
    expect(document.body.style.cursor).toBe('col-resize');
    act(() => window.dispatchEvent(pointerEvent('pointermove', { clientX: 600, pointerId: 7 })));
    expect(outer.style.maxWidth).toBe(`${NOTEBOOK_WIDTH_DEFAULT + 200}px`);

    act(() => window.dispatchEvent(pointerEvent('pointercancel', { pointerId: 7 })));
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');

    // cleanup済みなので、以降のpointermoveでは幅が変化しない。
    act(() => window.dispatchEvent(pointerEvent('pointermove', { clientX: 900, pointerId: 7 })));
    expect(outer.style.maxWidth).toBe(`${NOTEBOOK_WIDTH_DEFAULT + 200}px`);
  });

  test('ドラッグ中にコンポーネントがunmountされてもwindowのlistenerとbodyスタイルがリークしない', async () => {
    act(() => root.render(<Harness />));
    const rightHandle = container.querySelectorAll('[role="separator"]')[1] as HTMLElement;

    act(() =>
      rightHandle.dispatchEvent(pointerEvent('pointerdown', { clientX: 500, pointerId: 3 })),
    );
    expect(document.body.style.cursor).toBe('col-resize');

    await act(async () => root.unmount());

    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');

    // unmount後にpointermove/pointerupを送ってもエラーにならない（listenerが残っていない）。
    expect(() => {
      window.dispatchEvent(pointerEvent('pointermove', { clientX: 700, pointerId: 3 }));
      window.dispatchEvent(pointerEvent('pointerup', { pointerId: 3 }));
    }).not.toThrow();

    // 以降のafterEachでの再unmountに備えて新しいrootを張り直す。
    root = createRoot(container);
  });
});
