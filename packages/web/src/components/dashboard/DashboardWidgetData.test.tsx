// StrictModeの疑似cleanupでdashboard coordinatorを破棄しないことを検証する。
import { StrictMode } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { DashboardWidgetDataProvider, useDashboardWidgetData } from './DashboardWidgetData';
import { DashboardQueryCoordinator } from './widgetQueryCoordinator';

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = false;
});

test('StrictMode再setup後も一つの実行を所有し実unmountで中断する', async () => {
  let executionSignal: AbortSignal | undefined;
  const executor = vi.fn((_id: string, signal: AbortSignal) => {
    executionSignal = signal;
    return new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  const coordinator = new DashboardQueryCoordinator(1, executor);
  function Consumer() {
    useDashboardWidgetData('saved-strict', true);
    return null;
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() =>
    root.render(
      <StrictMode>
        <DashboardWidgetDataProvider coordinator={coordinator}>
          <Consumer />
        </DashboardWidgetDataProvider>
      </StrictMode>,
    ),
  );
  await vi.waitFor(() => expect(executor).toHaveBeenCalledOnce());
  expect(executionSignal?.aborted).toBe(false);

  act(() => root.unmount());
  await vi.waitFor(() => expect(executionSignal?.aborted).toBe(true));
  container.remove();
});
