// 履歴のRe-runが追加したセルと選択文を明示して実行することを検証する。
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { HistoryResponse } from '@hubble/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { useUiStore } from '../../stores/uiStore';
import { HistoryPanel } from './HistoryPanel';

const notebookActions = vi.hoisted(() => ({
  insertAtActiveCursor: vi.fn(),
  addSqlCellWithSource: vi.fn(() => 'history-cell'),
  runSqlCell: vi.fn(() => true),
}));

vi.mock('../../notebook', () => notebookActions);
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
  useDatasources: () => ({ datasources: [] }),
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
      shellContext: { catalog: 'shell_catalog', schema: 'shell_schema' },
      shellDefaultLimit: 4321,
    });
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
        datasourceId: undefined,
      },
      4321,
    );
  });
});
