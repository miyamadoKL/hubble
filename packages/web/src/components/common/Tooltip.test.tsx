// Tooltip のビューポート境界クランプを検証する。ユーザー指摘: TopBar 右端の
// LocaleToggle にホバーしたとき、中央寄せのツールチップが画面右端をはみ出して
// 見切れる。位置計算そのもの（clampToViewport）は DOM に依存しない純関数として
// 切り出してあるので値ベースで検証し、実際のコンポーネントは jsdom 上で
// getBoundingClientRect をモックして style.transform の変化を検証する。
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { clampToViewport, Tooltip } from './Tooltip';

describe('clampToViewport（純関数）', () => {
  test('はみ出しがなければ 0（中央寄せのまま）', () => {
    expect(clampToViewport(100, 200, 1024)).toBe(0);
  });

  test('右端をはみ出す場合、左へ寄せる分の負のオフセットを返す', () => {
    // viewport 幅 320、要素は [280, 380]（右へ 60px + margin 8px はみ出し）。
    expect(clampToViewport(280, 380, 320, 8)).toBe(320 - 8 - 380);
  });

  test('左端をはみ出す場合、右へ寄せる分の正のオフセットを返す', () => {
    // 要素は [-20, 40]（左へ 20px + margin 8px はみ出し）。
    expect(clampToViewport(-20, 40, 320, 8)).toBe(8 - -20);
  });

  test('margin を省略すると既定値（8px）が使われる', () => {
    expect(clampToViewport(0, 40, 320)).toBe(8 - 0);
  });
});

describe('Tooltip コンポーネント（画面端でのクランプ）', () => {
  let container: HTMLDivElement;
  let root: Root;
  const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
  const originalInnerWidth = window.innerWidth;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    Object.defineProperty(window, 'innerWidth', {
      value: originalInnerWidth,
      configurable: true,
    });
  });

  test('画面右端に近いトリガーでは、はみ出し分だけ左へクランプした transform になる', () => {
    Object.defineProperty(window, 'innerWidth', { value: 400, configurable: true });
    // ツールチップ本体（role="tooltip"）だけ、右端からはみ出す矩形を返すようにする。
    HTMLElement.prototype.getBoundingClientRect = vi.fn(function (this: HTMLElement) {
      if (this.getAttribute('role') === 'tooltip') {
        return {
          left: 350,
          right: 450,
          top: 0,
          bottom: 20,
          width: 100,
          height: 20,
          x: 350,
          y: 0,
          toJSON() {},
        } as DOMRect;
      }
      return {
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        width: 0,
        height: 0,
        x: 0,
        y: 0,
        toJSON() {},
      } as DOMRect;
    });

    act(() => {
      root.render(
        <Tooltip label="JA へ切替">
          <button type="button">EN</button>
        </Tooltip>,
      );
    });
    const trigger = container.querySelector('button')!;
    act(() => {
      trigger.focus();
    });

    const tooltip = container.querySelector('[role="tooltip"]') as HTMLElement;
    // 400(viewport) - 8(margin) - 450(right) = -58 だけ左へ寄る。
    expect(tooltip.style.transform).toBe('translateX(calc(-50% + -58px))');
  });

  test('はみ出しがなければ、追加オフセットなしの中央寄せのままになる', () => {
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
    HTMLElement.prototype.getBoundingClientRect = vi.fn(
      () =>
        ({
          left: 400,
          right: 500,
          top: 0,
          bottom: 20,
          width: 100,
          height: 20,
          x: 400,
          y: 0,
          toJSON() {},
        }) as DOMRect,
    );

    act(() => {
      root.render(
        <Tooltip label="説明">
          <button type="button">Btn</button>
        </Tooltip>,
      );
    });
    const trigger = container.querySelector('button')!;
    act(() => {
      trigger.focus();
    });

    const tooltip = container.querySelector('[role="tooltip"]') as HTMLElement;
    expect(tooltip.style.transform).toBe('translateX(calc(-50% + 0px))');
  });

  test('閉じて再表示しても、はみ出しクランプが維持される（2回目に 0px へ戻らない）', () => {
    // codex 診断で再現: clampOffset を適用済みの矩形をそのまま再測定すると、
    // その矩形はすでにビューポート内に収まっているため「はみ出しなし」と
    // 誤判定され、2回目の表示でクランプが解除されてしまう。
    Object.defineProperty(window, 'innerWidth', { value: 400, configurable: true });
    const NATURAL_LEFT = 350;
    const NATURAL_RIGHT = 450;
    // 実ブラウザの getBoundingClientRect は適用済みの CSS transform を反映した
    // 「現在の描画位置」を返す。ここでは自然位置 [350, 450] に、要素へ適用済みの
    // translateX オフセット（style.transform 文字列から抽出した px 値）を
    // 加算して、その挙動を模擬する。
    HTMLElement.prototype.getBoundingClientRect = vi.fn(function (this: HTMLElement) {
      if (this.getAttribute('role') !== 'tooltip') {
        return {
          left: 0,
          right: 0,
          top: 0,
          bottom: 0,
          width: 0,
          height: 0,
          x: 0,
          y: 0,
          toJSON() {},
        } as DOMRect;
      }
      const match = /translateX\(calc\(-50% \+ (-?\d+(?:\.\d+)?)px\)\)/.exec(this.style.transform);
      const appliedOffset = match ? Number(match[1]) : 0;
      return {
        left: NATURAL_LEFT + appliedOffset,
        right: NATURAL_RIGHT + appliedOffset,
        top: 0,
        bottom: 20,
        width: 100,
        height: 20,
        x: NATURAL_LEFT + appliedOffset,
        y: 0,
        toJSON() {},
      } as DOMRect;
    });

    act(() => {
      root.render(
        <Tooltip label="JA へ切替">
          <button type="button">EN</button>
        </Tooltip>,
      );
    });
    const trigger = container.querySelector('button')!;
    const tooltip = container.querySelector('[role="tooltip"]') as HTMLElement;

    // 1回目の表示: 400(viewport) - 8(margin) - 450(right) = -58 だけ左へ寄る。
    act(() => {
      trigger.focus();
    });
    expect(tooltip.style.transform).toBe('translateX(calc(-50% + -58px))');

    // 閉じる: clampOffset がリセットされ、次回の実測基準が自然位置に戻る。
    act(() => {
      trigger.blur();
    });
    expect(tooltip.style.transform).toBe('translateX(calc(-50% + 0px))');

    // 2回目の表示でも同じクランプが再適用される（0px のままはみ出さない）。
    act(() => {
      trigger.focus();
    });
    expect(tooltip.style.transform).toBe('translateX(calc(-50% + -58px))');
  });
});
