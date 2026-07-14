import { afterEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ResultProfile } from '@hubble/contracts';
import { ColumnProfilePanel } from './ColumnProfilePanel';

const fetchQueryProfile = vi.hoisted(() => vi.fn());
vi.mock('../../execution/api', () => ({ fetchQueryProfile }));

describe('ColumnProfilePanel', () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    focusManager.setFocused(undefined);
    container.remove();
    vi.clearAllMocks();
  });

  function render(queryId: string): void {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ColumnProfilePanel queryId={queryId} onClose={() => {}} />
        </QueryClientProvider>,
      );
    });
  }

  function setup(): void {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    fetchQueryProfile.mockImplementation((_queryId: string, signal: AbortSignal) => {
      signal.addEventListener('abort', () => undefined, { once: true });
      return new Promise(() => {});
    });
  }

  function profile(): ResultProfile {
    return {
      rowCount: 2,
      complete: true,
      columns: [
        {
          name: 'city',
          type: 'varchar',
          nullCount: 0,
          distinctCount: 2,
          distinctOverflow: false,
          min: 'Osaka',
          max: 'Tokyo',
          topValues: [{ value: 'Tokyo', count: 1 }],
        },
      ],
    };
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

  test('renders a successful profile', async () => {
    setup();
    fetchQueryProfile.mockResolvedValue(profile());
    render('q1');

    await vi.waitFor(() => expect(container.textContent).toContain('2 rows profiled'));
    expect(container.textContent).toContain('city');
    expect(fetchQueryProfile).toHaveBeenCalledTimes(1);
  });

  test('renders an error without retrying', async () => {
    setup();
    fetchQueryProfile.mockRejectedValue(new Error('profile failed'));
    render('q1');

    await vi.waitFor(() => expect(container.textContent).toContain('profile failed'));
    expect(fetchQueryProfile).toHaveBeenCalledTimes(1);
  });

  test('does not refetch on focus after a successful profile fetch', async () => {
    setup();
    fetchQueryProfile.mockResolvedValue(profile());
    render('q1');
    await vi.waitFor(() => expect(container.textContent).toContain('2 rows profiled'));

    focusManager.setFocused(false);
    act(() => focusManager.setFocused(true));
    await act(async () => Promise.resolve());
    expect(fetchQueryProfile).toHaveBeenCalledTimes(1);
  });
});
