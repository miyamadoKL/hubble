/** Notebook の領域外セルを軽量表示へ切り替える境界を検証する。 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Cell } from '@hubble/contracts';
import { ViewportCell } from './NotebookView';

const cell: Cell = {
  id: 'cell-1',
  kind: 'sql',
  name: 'Orders',
  source: 'SELECT *\nFROM orders',
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('ViewportCell', () => {
  it('mounts the heavy child only inside the overscanned viewport', () => {
    let notify: IntersectionObserverCallback | undefined;
    class FakeIntersectionObserver {
      constructor(callback: IntersectionObserverCallback) {
        notify = callback;
      }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);

    act(() => {
      root.render(
        <ViewportCell cell={cell} initiallyVisible={false} forceVisible={false}>
          <div>heavy editor</div>
        </ViewportCell>,
      );
    });
    expect(container.textContent).not.toContain('heavy editor');
    expect(container.textContent).toContain('SELECT *');

    act(() => {
      notify?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    });
    expect(container.textContent).toContain('heavy editor');
  });

  it('keeps an active cell mounted outside the viewport', () => {
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    act(() => {
      root.render(
        <ViewportCell cell={cell} initiallyVisible={false} forceVisible>
          <div>active editor</div>
        </ViewportCell>,
      );
    });
    expect(container.textContent).toContain('active editor');
  });
});
