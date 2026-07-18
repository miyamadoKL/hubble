import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  NOTEBOOK_WIDTH_ABSOLUTE_MAX,
  NOTEBOOK_WIDTH_DEFAULT,
  NOTEBOOK_WIDTH_MIN,
  NOTEBOOK_WIDTH_STORAGE_KEY,
  beginNotebookWidthResize,
  clampNotebookWidth,
  notebookWidthMax,
  readNotebookWidth,
  writeNotebookWidth,
} from './notebookWidth';

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

/** clientX を持つ擬似 PointerEvent を作る（jsdom は PointerEvent 未実装のため）。pointerId も付与できる。 */
function pointerEvent(
  type: string,
  { clientX, pointerId }: { clientX?: number; pointerId?: number },
): Event {
  const event = new Event(type, { bubbles: true }) as PointerEvent;
  if (clientX !== undefined) Object.defineProperty(event, 'clientX', { value: clientX });
  if (pointerId !== undefined) Object.defineProperty(event, 'pointerId', { value: pointerId });
  return event;
}

describe('clampNotebookWidth', () => {
  test('下限672pxを下回らない', () => {
    expect(clampNotebookWidth(100, 2000)).toBe(NOTEBOOK_WIDTH_MIN);
  });

  test('上限は絶対値1600pxとビューポート幅-32pxの小さい方', () => {
    // ビューポートが十分広ければ絶対上限の1600pxで頭打ちになる。
    expect(clampNotebookWidth(9999, 3000)).toBe(1600);
    // ビューポートが狭い場合はビューポート幅-32pxで頭打ちになる。
    expect(clampNotebookWidth(9999, 900)).toBe(868);
  });

  test('範囲内の値はそのまま（四捨五入のみ）保たれる', () => {
    expect(clampNotebookWidth(1000.4, 2000)).toBe(1000);
    expect(clampNotebookWidth(1000.6, 2000)).toBe(1001);
  });

  test('ビューポートが極端に狭くても下限を下回らない', () => {
    expect(clampNotebookWidth(700, 300)).toBe(NOTEBOOK_WIDTH_MIN);
  });
});

describe('notebookWidthMax', () => {
  test('ビューポートが十分広ければ絶対上限1600pxになる', () => {
    expect(notebookWidthMax(3000)).toBe(NOTEBOOK_WIDTH_ABSOLUTE_MAX);
  });

  test('ビューポートが狭い場合はビューポート幅-32pxになる', () => {
    expect(notebookWidthMax(900)).toBe(868);
  });

  test('ビューポートが極端に狭くても下限672pxを下回らない', () => {
    expect(notebookWidthMax(300)).toBe(NOTEBOOK_WIDTH_MIN);
  });
});

describe('readNotebookWidth / writeNotebookWidth', () => {
  test('未保存なら既定幅を返す', () => {
    expect(readNotebookWidth()).toBe(NOTEBOOK_WIDTH_DEFAULT);
  });

  test('書き込んだ値をそのまま読み戻す', () => {
    writeNotebookWidth(1200);
    expect(readNotebookWidth()).toBe(1200);
    expect(localStorage.getItem(NOTEBOOK_WIDTH_STORAGE_KEY)).toBe('1200');
  });

  test('壊れた値は既定幅にフォールバックする', () => {
    localStorage.setItem(NOTEBOOK_WIDTH_STORAGE_KEY, 'not-a-number');
    expect(readNotebookWidth()).toBe(NOTEBOOK_WIDTH_DEFAULT);
  });

  test('getItem自体が例外を投げても既定幅にフォールバックする（プライベートブラウジング等）', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('access denied');
    });
    try {
      expect(readNotebookWidth()).toBe(NOTEBOOK_WIDTH_DEFAULT);
    } finally {
      spy.mockRestore();
    }
  });

  test('setItem自体が例外を投げても致命的に落ちない', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded');
    });
    try {
      expect(() => writeNotebookWidth(1000)).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('beginNotebookWidthResize', () => {
  afterEach(() => {
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });

  test('pointercancelでもcleanupされ、bodyスタイルが元に戻りonEndが呼ばれる', () => {
    const setWidth = vi.fn();
    const onEnd = vi.fn();
    beginNotebookWidthResize('right', 100, 900, setWidth, onEnd, 1);

    expect(document.body.style.cursor).toBe('col-resize');
    window.dispatchEvent(pointerEvent('pointercancel', { pointerId: 1 }));

    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');

    // cleanup済みなので、以降のpointermoveは無視される。
    window.dispatchEvent(pointerEvent('pointermove', { clientX: 500, pointerId: 1 }));
    expect(setWidth).not.toHaveBeenCalled();
  });

  test('開始時と異なるpointerIdのイベントは無視する（マルチタッチ等）', () => {
    const setWidth = vi.fn();
    const onEnd = vi.fn();
    beginNotebookWidthResize('right', 100, 900, setWidth, onEnd, 1);

    // 無関係なポインタの移動・終了は無視される。
    window.dispatchEvent(pointerEvent('pointermove', { clientX: 200, pointerId: 2 }));
    expect(setWidth).not.toHaveBeenCalled();
    window.dispatchEvent(pointerEvent('pointerup', { pointerId: 2 }));
    expect(onEnd).not.toHaveBeenCalled();

    // 開始時と同じpointerIdなら反映される。
    window.dispatchEvent(pointerEvent('pointermove', { clientX: 200, pointerId: 1 }));
    expect(setWidth).toHaveBeenCalledWith(900 + (200 - 100) * 2);
    window.dispatchEvent(pointerEvent('pointerup', { pointerId: 1 }));
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  test('返り値のcleanupを直接呼んでも（unmount相当）listenerとbodyスタイルが解除される', () => {
    const setWidth = vi.fn();
    const onEnd = vi.fn();
    const cleanup = beginNotebookWidthResize('right', 100, 900, setWidth, onEnd, 1);

    cleanup();
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(document.body.style.cursor).toBe('');

    // cleanup後はpointermoveを送っても反応しない。
    window.dispatchEvent(pointerEvent('pointermove', { clientX: 999, pointerId: 1 }));
    expect(setWidth).not.toHaveBeenCalled();
    // 二重cleanupしてもonEndは再度呼ばれない。
    cleanup();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});
