import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  EDITOR_HEIGHT_MIN,
  clampEditorHeight,
  editorHeightMax,
  editorHeightsStorageKey,
  getEditorHeight,
  parseEditorHeights,
  pruneEditorHeights,
  resetEditorHeight,
  setEditorHeight,
} from './editorHeight';

// pointer ドラッグ（beginEditorHeightResize）の挙動は verticalDragResize.test.ts で
// 汎用実装として検証している（エディター固有のロジックを含まないため）。
//
// 手動オーバーライドの上限は仕様どおり常にビューポート高さの80%（下限
// EDITOR_HEIGHT_MIN 付き）で、EDITOR_AUTO_HEIGHT_MAX（40行相当の生の高さ）による
// 底上げは行わない。自動伸縮の高さがこのレンジを超えないようにする責務は
// SqlEditor 側（syncHeight が editorHeightMax(window.innerHeight) と min() を取る）に
// あり、その回帰テストは SqlEditor.resize.test.tsx 側で検証している。

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe('clampEditorHeight', () => {
  test('下限（4行相当=96px）を下回らない', () => {
    expect(clampEditorHeight(10, 1000)).toBe(EDITOR_HEIGHT_MIN);
  });

  test('上限はビューポート高さの80%', () => {
    expect(clampEditorHeight(9999, 1000)).toBe(800);
  });

  test('範囲内の値は四捨五入のみされる', () => {
    expect(clampEditorHeight(300.4, 1000)).toBe(300);
    expect(clampEditorHeight(300.6, 1000)).toBe(301);
  });

  test('ビューポートが極端に低くても下限を下回らない', () => {
    expect(clampEditorHeight(200, 50)).toBe(EDITOR_HEIGHT_MIN);
  });

  test('負数は下限にクランプされる', () => {
    expect(clampEditorHeight(-500, 1000)).toBe(EDITOR_HEIGHT_MIN);
  });

  test('巨大な値は上限にクランプされる', () => {
    expect(clampEditorHeight(Number.MAX_SAFE_INTEGER, 1000)).toBe(800);
  });

  // 768px高のビューポート（jsdomの既定値）では80%相当が614pxとなり、40行分の
  // 自動伸縮（816px）を下回る。手動オーバーライドの仕様（上限=80vh）どおり、
  // ここでは底上げせず614pxへクランプする（自動伸縮側を614pxへ収める責務は
  // SqlEditor 側にある）。
  test('768px高のビューポートでは、80%相当（614px）が上限になる（816pxへの底上げはしない）', () => {
    expect(clampEditorHeight(816, 768)).toBe(614);
    expect(clampEditorHeight(9999, 768)).toBe(614);
  });
});

describe('editorHeightMax', () => {
  test('ビューポート高さの80%になる', () => {
    expect(editorHeightMax(1000)).toBe(800);
  });

  test('ビューポートが極端に低くても下限を下回らない', () => {
    expect(editorHeightMax(50)).toBe(EDITOR_HEIGHT_MIN);
  });

  // 40行分の自動伸縮（816px）による底上げはしない。768px高のビューポートでは
  // 80%相当の614pxがそのまま上限になる。
  test('768px高のビューポートでは、80%相当（614px）が上限になる', () => {
    expect(editorHeightMax(768)).toBe(614);
  });
});

describe('parseEditorHeights', () => {
  test('nullや空文字は空マップになる', () => {
    expect(parseEditorHeights(null)).toEqual({});
    expect(parseEditorHeights('')).toEqual({});
  });

  test('壊れたJSONは例外を投げず空マップになる', () => {
    expect(parseEditorHeights('{not json')).toEqual({});
  });

  test('オブジェクトでない値は空マップになる', () => {
    expect(parseEditorHeights('[1,2,3]')).toEqual({});
    expect(parseEditorHeights('"str"')).toEqual({});
  });

  test('数値でないエントリだけを除外する', () => {
    expect(parseEditorHeights(JSON.stringify({ a: 200, b: 'nope', c: NaN }))).toEqual({ a: 200 });
  });

  test('負数や巨大な値もクランプせず生のまま返す（クランプは呼び出し側の責務）', () => {
    expect(parseEditorHeights(JSON.stringify({ a: -500, b: 999999 }))).toEqual({
      a: -500,
      b: 999999,
    });
  });
});

describe('pruneEditorHeights', () => {
  test('現在存在するセルIDだけを残す', () => {
    const heights = { 'cell-1': 200, 'cell-2': 300, 'cell-stale': 400 };
    expect(pruneEditorHeights(heights, new Set(['cell-1', 'cell-2']))).toEqual({
      'cell-1': 200,
      'cell-2': 300,
    });
  });
});

describe('getEditorHeight / setEditorHeight / resetEditorHeight', () => {
  test('未調整のセルは null を返す', () => {
    expect(getEditorHeight('nb-1', 'cell-1')).toBeNull();
  });

  test('setEditorHeightで保存した値をgetEditorHeightで読み戻す', () => {
    setEditorHeight('nb-1', 'cell-1', 260.9);
    expect(getEditorHeight('nb-1', 'cell-1')).toBe(261);
  });

  test('同じノートブックの他セルのエントリを保持したまま書き込む', () => {
    setEditorHeight('nb-1', 'cell-1', 200);
    setEditorHeight('nb-1', 'cell-2', 300);
    expect(getEditorHeight('nb-1', 'cell-1')).toBe(200);
    expect(getEditorHeight('nb-1', 'cell-2')).toBe(300);
  });

  test('resetEditorHeightでエントリを解除するとnullに戻る', () => {
    setEditorHeight('nb-1', 'cell-1', 200);
    resetEditorHeight('nb-1', 'cell-1');
    expect(getEditorHeight('nb-1', 'cell-1')).toBeNull();
  });

  test('ノートブックIDごとに別キーへ保存される', () => {
    setEditorHeight('nb-1', 'cell-1', 200);
    expect(getEditorHeight('nb-2', 'cell-1')).toBeNull();
    expect(localStorage.getItem(editorHeightsStorageKey('nb-1'))).not.toBeNull();
    expect(localStorage.getItem(editorHeightsStorageKey('nb-2'))).toBeNull();
  });

  test('結果表示域（resultHeights）とは別の localStorage キーを使う', () => {
    setEditorHeight('nb-1', 'cell-1', 200);
    expect(editorHeightsStorageKey('nb-1')).not.toBe('hubble.ui.resultHeights.nb-1');
    expect(editorHeightsStorageKey('nb-1')).toContain('editorHeights');
  });

  test('getItem自体が例外を投げても空マップ扱いになる（プライベートブラウジング等）', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('access denied');
    });
    try {
      expect(getEditorHeight('nb-1', 'cell-1')).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  test('setItem自体が例外を投げても致命的に落ちない', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded');
    });
    try {
      expect(() => setEditorHeight('nb-1', 'cell-1', 200)).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});
