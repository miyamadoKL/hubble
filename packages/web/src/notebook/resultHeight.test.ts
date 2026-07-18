import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  RESULT_HEIGHT_MIN,
  beginResultHeightResize,
  clampResultHeight,
  getResultHeight,
  parseResultHeights,
  pruneResultHeights,
  resetResultHeight,
  resultHeightMax,
  resultHeightsStorageKey,
  setResultHeight,
} from './resultHeight';

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

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

describe('clampResultHeight', () => {
  test('下限128pxを下回らない', () => {
    expect(clampResultHeight(10, 1000)).toBe(RESULT_HEIGHT_MIN);
  });

  test('上限はビューポート高さの80%', () => {
    expect(clampResultHeight(9999, 1000)).toBe(800);
  });

  test('範囲内の値は四捨五入のみされる', () => {
    expect(clampResultHeight(300.4, 1000)).toBe(300);
    expect(clampResultHeight(300.6, 1000)).toBe(301);
  });

  test('ビューポートが極端に低くても下限を下回らない', () => {
    expect(clampResultHeight(200, 100)).toBe(RESULT_HEIGHT_MIN);
  });

  test('負数は下限にクランプされる', () => {
    expect(clampResultHeight(-500, 1000)).toBe(RESULT_HEIGHT_MIN);
  });

  test('巨大な値は上限にクランプされる', () => {
    expect(clampResultHeight(Number.MAX_SAFE_INTEGER, 1000)).toBe(800);
  });
});

describe('resultHeightMax', () => {
  test('ビューポート高さの80%になる', () => {
    expect(resultHeightMax(1000)).toBe(800);
  });

  test('ビューポートが極端に低くても下限128pxを下回らない', () => {
    expect(resultHeightMax(50)).toBe(RESULT_HEIGHT_MIN);
  });
});

describe('parseResultHeights', () => {
  test('nullや空文字は空マップになる', () => {
    expect(parseResultHeights(null)).toEqual({});
    expect(parseResultHeights('')).toEqual({});
  });

  test('壊れたJSONは例外を投げず空マップになる', () => {
    expect(parseResultHeights('{not json')).toEqual({});
  });

  test('オブジェクトでない値は空マップになる', () => {
    expect(parseResultHeights('[1,2,3]')).toEqual({});
    expect(parseResultHeights('"str"')).toEqual({});
  });

  test('数値でないエントリだけを除外する', () => {
    expect(parseResultHeights(JSON.stringify({ a: 200, b: 'nope', c: NaN }))).toEqual({ a: 200 });
  });

  // parseResultHeights自体は有限値ならクランプせずそのまま返す（列幅側の readNotebookWidth と
  // 同じ設計: クランプはビューポート情報を持つ呼び出し側で行う）。ここでは「クランプされない生の値の
  // まま読み出せる」ことを保証し、実際のクランプは clampResultHeight 側のテストと
  // ResultGrid.resize.test.tsx の描画時クランプで検証する。
  test('負数や巨大な値もクランプせず生のまま返す（クランプは呼び出し側の責務）', () => {
    expect(parseResultHeights(JSON.stringify({ a: -500, b: 999999 }))).toEqual({
      a: -500,
      b: 999999,
    });
  });
});

describe('pruneResultHeights', () => {
  test('現在存在するセルIDだけを残す', () => {
    const heights = { 'cell-1': 200, 'cell-2': 300, 'cell-stale': 400 };
    expect(pruneResultHeights(heights, new Set(['cell-1', 'cell-2']))).toEqual({
      'cell-1': 200,
      'cell-2': 300,
    });
  });
});

describe('getResultHeight / setResultHeight / resetResultHeight', () => {
  test('未調整のセルは null を返す', () => {
    expect(getResultHeight('nb-1', 'cell-1')).toBeNull();
  });

  test('setResultHeightで保存した値をgetResultHeightで読み戻す', () => {
    setResultHeight('nb-1', 'cell-1', 260.9);
    expect(getResultHeight('nb-1', 'cell-1')).toBe(261);
  });

  test('同じノートブックの他セルのエントリを保持したまま書き込む', () => {
    setResultHeight('nb-1', 'cell-1', 200);
    setResultHeight('nb-1', 'cell-2', 300);
    expect(getResultHeight('nb-1', 'cell-1')).toBe(200);
    expect(getResultHeight('nb-1', 'cell-2')).toBe(300);
  });

  test('resetResultHeightでエントリを解除するとnullに戻る', () => {
    setResultHeight('nb-1', 'cell-1', 200);
    resetResultHeight('nb-1', 'cell-1');
    expect(getResultHeight('nb-1', 'cell-1')).toBeNull();
  });

  test('ノートブックIDごとに別キーへ保存される', () => {
    setResultHeight('nb-1', 'cell-1', 200);
    expect(getResultHeight('nb-2', 'cell-1')).toBeNull();
    expect(localStorage.getItem(resultHeightsStorageKey('nb-1'))).not.toBeNull();
    expect(localStorage.getItem(resultHeightsStorageKey('nb-2'))).toBeNull();
  });

  test('getItem自体が例外を投げても空マップ扱いになる（プライベートブラウジング等）', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('access denied');
    });
    try {
      expect(getResultHeight('nb-1', 'cell-1')).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  test('setItem自体が例外を投げても致命的に落ちない', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded');
    });
    try {
      expect(() => setResultHeight('nb-1', 'cell-1', 200)).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('beginResultHeightResize', () => {
  afterEach(() => {
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });

  test('pointercancelでもcleanupされ、bodyスタイルが元に戻りonEndが呼ばれる', () => {
    const setHeight = vi.fn();
    const onEnd = vi.fn();
    beginResultHeightResize(300, 200, setHeight, onEnd, 1);

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
    beginResultHeightResize(300, 200, setHeight, onEnd, 1);

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
    const cleanup = beginResultHeightResize(300, 200, setHeight, onEnd, 1);

    cleanup();
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(document.body.style.cursor).toBe('');

    window.dispatchEvent(pointerEvent('pointermove', { clientY: 999, pointerId: 1 }));
    expect(setHeight).not.toHaveBeenCalled();
    cleanup();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});
