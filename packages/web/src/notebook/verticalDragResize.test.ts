import { afterEach, describe, expect, test, vi } from 'vitest';
import { beginVerticalDragResize } from './verticalDragResize';
import { beginResultHeightResize } from './resultHeight';
import { beginEditorHeightResize } from './editorHeight';

/** clientY を持つ擬似 PointerEvent を作る（jsdom は PointerEvent 未実装のため）。pointerId も付与できる。 */
function pointerEvent(
  type: string,
  { clientY, pointerId }: { clientY?: number; pointerId?: number },
): Event {
  const event = new Event(type, { bubbles: true }) as PointerEvent;
  if (clientY !== undefined) Object.defineProperty(event, 'clientY', { value: clientY });
  if (pointerId !== undefined) Object.defineProperty(event, 'pointerId', { value: pointerId });
  return event;
}

describe('resultHeight / editorHeight の re-export は同じ実装を指す', () => {
  test('beginResultHeightResize と beginEditorHeightResize はどちらも beginVerticalDragResize', () => {
    expect(beginResultHeightResize).toBe(beginVerticalDragResize);
    expect(beginEditorHeightResize).toBe(beginVerticalDragResize);
  });
});

describe('beginVerticalDragResize', () => {
  afterEach(() => {
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });

  test('pointercancelでもcleanupされ、bodyスタイルが元に戻りonEndが呼ばれる', () => {
    const setHeight = vi.fn();
    const onEnd = vi.fn();
    beginVerticalDragResize(300, 200, setHeight, onEnd, 1);

    expect(document.body.style.cursor).toBe('row-resize');
    window.dispatchEvent(pointerEvent('pointercancel', { pointerId: 1 }));

    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');

    // cleanup済みなので、以降のpointermoveは無視される。
    window.dispatchEvent(pointerEvent('pointermove', { clientY: 500, pointerId: 1 }));
    expect(setHeight).not.toHaveBeenCalled();
  });

  test('開始時と異なるpointerIdのイベントは無視する（マルチタッチ等）', () => {
    const setHeight = vi.fn();
    const onEnd = vi.fn();
    beginVerticalDragResize(300, 200, setHeight, onEnd, 1);

    window.dispatchEvent(pointerEvent('pointermove', { clientY: 400, pointerId: 2 }));
    expect(setHeight).not.toHaveBeenCalled();
    window.dispatchEvent(pointerEvent('pointerup', { pointerId: 2 }));
    expect(onEnd).not.toHaveBeenCalled();

    window.dispatchEvent(pointerEvent('pointermove', { clientY: 400, pointerId: 1 }));
    expect(setHeight).toHaveBeenCalledWith(200 + (400 - 300));
    window.dispatchEvent(pointerEvent('pointerup', { pointerId: 1 }));
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  test('返り値のcleanupを直接呼んでも（unmount相当）listenerとbodyスタイルが解除される', () => {
    const setHeight = vi.fn();
    const onEnd = vi.fn();
    const cleanup = beginVerticalDragResize(300, 200, setHeight, onEnd, 1);

    cleanup();
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(document.body.style.cursor).toBe('');

    window.dispatchEvent(pointerEvent('pointermove', { clientY: 999, pointerId: 1 }));
    expect(setHeight).not.toHaveBeenCalled();
    cleanup();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});
