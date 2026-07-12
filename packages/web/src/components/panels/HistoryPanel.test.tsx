// 履歴のRe-runが追加したセルと選択文を明示して実行することを検証する。
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { HistoryResponse } from '@hubble/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { useDatasourceStore } from '../../stores/datasourceStore';
import { useUiStore } from '../../stores/uiStore';
import { useToastStore } from '../common/Toast';
import { HistoryPanel } from './HistoryPanel';

const notebookActions = vi.hoisted(() => ({
  insertAtActiveCursor: vi.fn(),
  addSqlCellWithSource: vi.fn(() => 'history-cell'),
  runSqlCell: vi.fn(() => true),
}));
const executionMocks = vi.hoisted(() => ({ restoreCell: vi.fn() }));

vi.mock('../../notebook', () => notebookActions);
vi.mock('../../execution', () => ({
  executionActions: () => ({ restoreCell: executionMocks.restoreCell }),
}));
vi.mock('../../api/history', () => ({
  HISTORY_PAGE_SIZE: 50,
  fetchHistory: vi.fn(
    async (): Promise<HistoryResponse> => ({
      items: [
        {
          id: 'history-1',
          statement: 'SELECT * FROM selected_history',
          catalog: 'history_catalog',
          schema: 'history_schema',
          state: 'finished',
          rowCount: 1,
          resultAvailable: true,
          elapsedMs: 10,
          submittedAt: '2026-07-12T00:00:00.000Z',
        },
      ],
      offset: 0,
      limit: 50,
      total: 1,
    }),
  ),
}));
vi.mock('../../hooks/useDatasources', () => ({
  useDatasources: () => ({
    datasources: [
      {
        id: 'warehouse',
        kind: 'trino',
        displayName: 'Warehouse',
        capabilities: { costEstimate: true, catalogs: true },
      },
    ],
  }),
}));

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

describe('HistoryPanel Re-run', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    notebookActions.addSqlCellWithSource.mockReturnValue('history-cell');
    notebookActions.runSqlCell.mockReturnValue(true);
    useUiStore.setState({
      shellContext: {
        datasourceId: 'warehouse',
        catalog: 'shell_catalog',
        schema: 'shell_schema',
      },
      shellDefaultLimit: 4321,
    });
    useDatasourceStore.setState({
      selectedId: 'warehouse',
      executionContext: {
        datasourceId: 'warehouse',
        catalog: 'shell_catalog',
        schema: 'shell_schema',
      },
    });
    useToastStore.setState({ toasts: [] });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <HistoryPanel />
        </QueryClientProvider>,
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  test('追加したcellIdと履歴statementをrunSqlCellへ渡す', async () => {
    await vi.waitFor(() => expect(container.textContent).toContain('selected_history'));
    const row = [...container.querySelectorAll('button')].find(
      (button) => button.getAttribute('aria-expanded') === 'false',
    );
    expect(row).toBeDefined();
    await act(async () => row!.click());

    const rerun = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Re-run',
    );
    expect(rerun).toBeDefined();
    await act(async () => rerun!.click());

    expect(notebookActions.addSqlCellWithSource).toHaveBeenCalledWith(
      'SELECT * FROM selected_history',
    );
    expect(notebookActions.runSqlCell).toHaveBeenCalledWith(
      'history-cell',
      'SELECT * FROM selected_history',
      {
        catalog: 'history_catalog',
        schema: 'history_schema',
        datasourceId: 'warehouse',
      },
      4321,
    );
  });

  test('保存結果を復元できない場合は成功通知を出さない', async () => {
    executionMocks.restoreCell.mockResolvedValue('unavailable');
    await vi.waitFor(() => expect(container.textContent).toContain('selected_history'));
    const row = [...container.querySelectorAll('button')].find(
      (button) => button.getAttribute('aria-expanded') === 'false',
    );
    await act(async () => row!.click());
    const openResult = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Open result',
    );
    expect(openResult).toBeDefined();

    await act(async () => openResult!.click());
    await vi.waitFor(() =>
      expect(useToastStore.getState().toasts.at(-1)).toMatchObject({
        variant: 'error',
        title: 'Saved result unavailable',
      }),
    );
    expect(useToastStore.getState().toasts.some((item) => item.variant === 'success')).toBe(false);
  });
});
