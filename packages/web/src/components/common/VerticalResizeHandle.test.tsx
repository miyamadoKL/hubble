/**
 * VerticalResizeHandle の共通見た目（常時視認できるグリップ）とキーボード操作の
 * 配線を検証する。実際のドラッグ/永続化の挙動は、これを使う側
 * （ResultGrid.resize.test.tsx / SqlEditor.resize.test.tsx）でそれぞれ検証している。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { VerticalResizeHandle } from './VerticalResizeHandle';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function handle(): HTMLElement {
  return container.querySelector('[role="separator"]') as HTMLElement;
}

describe('VerticalResizeHandle', () => {
  test('通常状態でグリップが常時見えるスタイルを持つ（透明ではない）', () => {
    act(() => {
      root.render(
        <VerticalResizeHandle
          ariaLabel="test"
          valueNow={100}
          valueMin={0}
          valueMax={200}
          onPointerDown={() => {}}
          onDoubleClick={() => {}}
          onAdjust={() => {}}
        />,
      );
    });
    const grip = handle().querySelector('span');
    expect(grip?.className).toContain('bg-border-base');
    expect(grip?.className).not.toContain('bg-transparent');
    expect(handle().className).toContain('cursor-row-resize');
    expect(handle().className).toContain('touch-none');
  });

  test('aria属性がvalueNow/valueMin/valueMaxをそのまま反映する', () => {
    act(() => {
      root.render(
        <VerticalResizeHandle
          ariaLabel="高さを調整"
          valueNow={150}
          valueMin={50}
          valueMax={300}
          onPointerDown={() => {}}
          onDoubleClick={() => {}}
          onAdjust={() => {}}
        />,
      );
    });
    const el = handle();
    expect(el.getAttribute('aria-label')).toBe('高さを調整');
    expect(el.getAttribute('aria-valuenow')).toBe('150');
    expect(el.getAttribute('aria-valuemin')).toBe('50');
    expect(el.getAttribute('aria-valuemax')).toBe('300');
    expect(el.getAttribute('aria-orientation')).toBe('horizontal');
    expect(el.tabIndex).toBe(0);
  });

  test('ArrowUp/ArrowDownはonAdjustへ±16pxを渡し、既定動作をpreventDefaultする', () => {
    const onAdjust = vi.fn();
    act(() => {
      root.render(
        <VerticalResizeHandle
          ariaLabel="test"
          valueNow={100}
          valueMin={0}
          valueMax={200}
          onPointerDown={() => {}}
          onDoubleClick={() => {}}
          onAdjust={onAdjust}
        />,
      );
    });
    const down = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
      cancelable: true,
    });
    act(() => handle().dispatchEvent(down));
    expect(onAdjust).toHaveBeenCalledWith(16);
    expect(down.defaultPrevented).toBe(true);

    const up = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true });
    act(() => handle().dispatchEvent(up));
    expect(onAdjust).toHaveBeenCalledWith(-16);
    expect(up.defaultPrevented).toBe(true);
  });

  test('他のキーは無視され、既定動作は妨げない', () => {
    const onAdjust = vi.fn();
    act(() => {
      root.render(
        <VerticalResizeHandle
          ariaLabel="test"
          valueNow={100}
          valueMin={0}
          valueMax={200}
          onPointerDown={() => {}}
          onDoubleClick={() => {}}
          onAdjust={onAdjust}
        />,
      );
    });
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    act(() => handle().dispatchEvent(event));
    expect(onAdjust).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  test('pointerdown/dblclickはそれぞれのハンドラーへ委譲される', () => {
    const onPointerDown = vi.fn();
    const onDoubleClick = vi.fn();
    act(() => {
      root.render(
        <VerticalResizeHandle
          ariaLabel="test"
          valueNow={100}
          valueMin={0}
          valueMax={200}
          onPointerDown={onPointerDown}
          onDoubleClick={onDoubleClick}
          onAdjust={() => {}}
        />,
      );
    });
    act(() => handle().dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(onPointerDown).toHaveBeenCalledTimes(1);
    act(() => handle().dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(onDoubleClick).toHaveBeenCalledTimes(1);
  });
});
