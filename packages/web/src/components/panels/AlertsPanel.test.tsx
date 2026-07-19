// AlertsPanel の一覧表示（レビュー指摘: selector の契約値 first/max/min が翻訳されずに
// 生表示のままだった）と、評価完了トースト（レビュー指摘: result.state の契約値が
// 翻訳されずに生表示のままだった）が ja ロケールで翻訳されることを検証する。
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Alert, AlertEvalResponse } from '@hubble/contracts';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { LocaleProvider } from '../../i18n/locale';
import { toast } from '../common/Toast';

vi.mock('../../api/alerts', () => ({
  listAlerts: vi.fn(),
  createAlert: vi.fn(),
  updateAlert: vi.fn(),
  deleteAlert: vi.fn(),
  evalAlertNow: vi.fn(),
}));

vi.mock('../../api/savedQueries', () => ({
  listSavedQueries: vi.fn(),
}));

import { listAlerts, evalAlertNow } from '../../api/alerts';
import { listSavedQueries } from '../../api/savedQueries';
import { AlertsPanel } from './AlertsPanel';

const timestamp = '2026-07-12T00:00:00.000Z';

function alert(over: Partial<Alert> = {}): Alert {
  return {
    id: 'alert-1',
    name: 'Row count guard',
    savedQueryId: 'saved-1',
    columnName: 'n',
    op: '>',
    value: '0',
    selector: 'max',
    rearm: 0,
    muted: false,
    cron: '0 9 * * *',
    state: 'unknown',
    lastTriggeredAt: null,
    notifications: { channels: [] },
    createdAt: timestamp,
    updatedAt: timestamp,
    nextEvalAt: null,
    ...over,
  };
}

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

function renderPanel(language: string = 'ja-JP') {
  Object.defineProperty(window.navigator, 'language', { value: language, configurable: true });
  window.localStorage.clear();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <LocaleProvider>
          <AlertsPanel search="" />
        </LocaleProvider>
      </QueryClientProvider>,
    );
  });
  return { container, root };
}

describe('AlertsPanel: ja ロケールで契約値の生表示が残らない', () => {
  let container: HTMLDivElement;
  let root: Root;

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  test('一覧行の selector（first/max/min）がフォームと同じ表示ラベルに翻訳される', async () => {
    vi.mocked(listAlerts).mockResolvedValue([alert({ selector: 'max' })]);
    vi.mocked(listSavedQueries).mockResolvedValue([]);
    ({ container, root } = renderPanel());

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Row count guard');
    });
    // selector='max' の契約値がそのまま出る "(max)" ではなく、翻訳ラベル
    // 「最大値」で表示される。
    expect(container.textContent).toContain('最大値');
    expect(container.textContent).not.toContain('(max)');
  });

  test('評価完了トーストの state（契約値）が翻訳ラベルで表示される', async () => {
    vi.mocked(listAlerts).mockResolvedValue([alert({ id: 'alert-2' })]);
    vi.mocked(listSavedQueries).mockResolvedValue([]);
    vi.mocked(evalAlertNow).mockResolvedValue({
      state: 'triggered',
      previousState: 'ok',
      conditionMet: true,
      observedValue: '5',
      notified: false,
      errorType: null,
      errorMessage: null,
    } satisfies AlertEvalResponse);
    const toastInfo = vi.spyOn(toast, 'info');

    ({ container, root } = renderPanel());
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Row count guard');
    });

    const evalButton = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === '今すぐ評価',
    );
    expect(evalButton).toBeTruthy();
    await act(async () => {
      evalButton!.click();
      // useMutation の onSuccess が発火するまでマイクロタスクを1周待つ。
      await Promise.resolve();
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(toastInfo).toHaveBeenCalled();
    });
    const [, body] = toastInfo.mock.calls[toastInfo.mock.calls.length - 1]!;
    // state='triggered' の契約値がそのまま出る "State: triggered" ではなく、
    // AlertStateBadge と同じ翻訳ラベル「発火中」を含む本文になる。
    expect(body).toContain('発火中');
    expect(body).not.toContain('triggered');
  });

  // UI/UX から cron 式表示を極力排除する方針（scheduleCron.ts の describeCronForList）
  // に沿って、一覧行が生の cron 式を出さないことを検証する。
  test('一覧行: プリセット式（0 9 * * *）が読み下し文になり、生の式は出ない', async () => {
    vi.mocked(listAlerts).mockResolvedValue([alert({ cron: '0 9 * * *' })]);
    vi.mocked(listSavedQueries).mockResolvedValue([]);
    ({ container, root } = renderPanel());

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Row count guard');
    });
    expect(container.textContent).toContain('毎日 09:00 に実行');
    expect(container.textContent).not.toContain('0 9 * * *');
  });

  test('一覧行: カスタム式（*/7 2-4 * * *）が「カスタムスケジュール」になり、生の式は出ない', async () => {
    vi.mocked(listAlerts).mockResolvedValue([alert({ cron: '*/7 2-4 * * *' })]);
    vi.mocked(listSavedQueries).mockResolvedValue([]);
    ({ container, root } = renderPanel());

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Row count guard');
    });
    expect(container.textContent).toContain('カスタムスケジュール');
    expect(container.textContent).not.toContain('*/7 2-4 * * *');
  });

  test('en 一覧行: プリセット式は読み下し文、カスタム式は "Custom schedule" になる', async () => {
    vi.mocked(listAlerts).mockResolvedValue([alert({ id: 'alert-3', cron: '0 9 * * *' })]);
    vi.mocked(listSavedQueries).mockResolvedValue([]);
    ({ container, root } = renderPanel('en-US'));

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Row count guard');
    });
    expect(container.textContent).toContain('Daily at 09:00');
    expect(container.textContent).not.toContain('0 9 * * *');
  });
});
