import { afterEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ColumnProfilePanel } from './ColumnProfilePanel';

const fetchQueryProfile = vi.hoisted(() => vi.fn());
vi.mock('../../execution/api', () => ({ fetchQueryProfile }));

describe('ColumnProfilePanel', () => {
  let container: HTMLDivElement;
  let root: Root;

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  function render(queryId: string): void {
    act(() => {
      root.render(<ColumnProfilePanel queryId={queryId} onClose={() => {}} />);
    });
  }

  function setup(): void {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    fetchQueryProfile.mockImplementation((_queryId: string, signal: AbortSignal) => {
      signal.addEventListener('abort', () => undefined, { once: true });
      return new Promise(() => {});
    });
  }

  test('aborts the profile request when the panel unmounts', () => {
    setup();
    render('q1');

    const signal = fetchQueryProfile.mock.calls[0]?.[1] as AbortSignal;
    expect(signal.aborted).toBe(false);
    act(() => root.unmount());
    expect(signal.aborted).toBe(true);
  });

  test('aborts the previous profile request when queryId changes', () => {
    setup();
    render('q1');
    const firstSignal = fetchQueryProfile.mock.calls[0]?.[1] as AbortSignal;

    render('q2');

    const secondSignal = fetchQueryProfile.mock.calls[1]?.[1] as AbortSignal;
    expect(firstSignal.aborted).toBe(true);
    expect(secondSignal.aborted).toBe(false);
    expect(fetchQueryProfile).toHaveBeenNthCalledWith(2, 'q2', expect.any(AbortSignal));
  });
});
