// i18n フェーズ 2c（HistoryPanel / SavedQueriesPanel / OperationsPanel /
// NotebookListPanel）の代表的なラベルが、LocaleProvider のロケールに応じて
// 日本語/英語で切り替わることを確認する。i18nLocaleSwitch.test.tsx
// （Schedule/Alert 領域）と同じパターンに倣う。
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  AdminQueryItem,
  HistoryResponse,
  MeResponse,
  NotebookListItem,
  SavedQueryResponse,
} from '@hubble/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { LocaleProvider, type Locale } from '../../i18n/locale';

const notebookActions = vi.hoisted(() => ({
  insertAtActiveCursor: vi.fn(),
  addSqlCellWithSource: vi.fn(() => 'cell-id'),
  runSqlCell: vi.fn(() => true),
}));

vi.mock('../../notebook', () => notebookActions);
vi.mock('../../execution', () => ({
  executionActions: () => ({ restoreCell: vi.fn() }),
}));
vi.mock('../../api/history', () => ({
  HISTORY_PAGE_SIZE: 50,
  fetchHistory: vi.fn(
    async (): Promise<HistoryResponse> => ({
      items: [
        {
          id: 'history-1',
          statement: 'SELECT * FROM locale_switch',
          catalog: 'demo_catalog',
          schema: 'demo_schema',
          state: 'finished',
          rowCount: 3,
          resultAvailable: false,
          elapsedMs: 12,
          submittedAt: '2026-07-12T00:00:00.000Z',
        },
      ],
      offset: 0,
      limit: 50,
      total: 1,
    }),
  ),
}));
vi.mock('../../api/savedQueries', () => ({
  listSavedQueries: vi.fn(
    async (): Promise<SavedQueryResponse[]> => [
      {
        id: 'sq-1',
        name: 'Locale switch query',
        description: '',
        statement: 'SELECT 1',
        catalog: '',
        schema: '',
        datasourceId: undefined,
        isFavorite: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        owner: 'admin',
        myPermission: 'owner',
      },
    ],
  ),
  updateSavedQuery: vi.fn(),
  deleteSavedQuery: vi.fn(),
  listSavedQueryShares: vi.fn(),
  updateSavedQueryShares: vi.fn(),
}));
vi.mock('../../hooks/useDatasources', () => ({
  resolveDatasourceLabel: (_datasources: unknown[], id: string) => id,
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
vi.mock('../../hooks/useAdminQueries', () => ({
  useAdminQueries: () => ({
    data: {
      items: [
        {
          queryId: 'q-1',
          owner: 'alice',
          state: 'running',
          statement: 'SELECT * FROM operations_demo',
          datasourceId: 'warehouse',
          elapsedMs: 500,
        } satisfies AdminQueryItem,
      ],
    },
    isLoading: false,
    isError: false,
  }),
  useKillAdminQuery: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('../../hooks/useMe', () => ({
  useMe: () => ({
    data: {
      permissions: ['queries.viewAll', 'query.killAny'],
    } as unknown as MeResponse,
  }),
}));

import { HistoryPanel } from './HistoryPanel';
import { SavedQueriesPanel } from './SavedQueriesPanel';
import { OperationsPanel } from './OperationsPanel';
import { NotebookListPanel } from './NotebookListPanel';

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

// LocaleProvider は localStorage → navigator.language の順で初期ロケールを決めるため、
// テストごとに navigator.language を明示的に固定してから mount する。
function withLocale(locale: Locale, fn: () => void): void {
  Object.defineProperty(window.navigator, 'language', {
    value: locale === 'ja' ? 'ja-JP' : 'en-US',
    configurable: true,
  });
  window.localStorage.clear();
  fn();
}

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

function renderWithLocale(locale: Locale, node: React.ReactNode) {
  withLocale(locale, () => {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <LocaleProvider>{node}</LocaleProvider>
        </QueryClientProvider>,
      );
    });
  });
}

describe('HistoryPanel: ロケール切替でフィルタチップ/操作ボタンが日英で切り替わる', () => {
  test('ja ロケールでは日本語ラベルが表示される', async () => {
    renderWithLocale('ja', <HistoryPanel />);
    await vi.waitFor(() => expect(container.textContent).toContain('locale_switch'));
    expect(container.textContent).toContain('すべて');
    expect(container.textContent).toContain('完了');
    // state バッジ(entry.state === 'finished')の表示テキストも翻訳される
    // (QueryStateBadge 経由。common/StateBadge.tsx の生の契約値ではないことの確認)。
    expect(container.textContent).toContain('完了');
    expect(container.textContent).not.toContain('FINISHED');

    const row = [...container.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-expanded') === 'false',
    )!;
    await act(async () => row.click());
    expect(container.textContent).toContain('挿入');
    expect(container.textContent).toContain('新規セル');
    expect(container.textContent).toContain('再実行');
  });

  test('en ロケールでは既存どおり英語ラベルのまま', async () => {
    renderWithLocale('en', <HistoryPanel />);
    await vi.waitFor(() => expect(container.textContent).toContain('locale_switch'));
    expect(container.textContent).toContain('All');
    expect(container.textContent).toContain('Finished');
    // state バッジ(entry.state === 'finished')は en ロケールでは従来どおり
    // 契約値の大文字表記("FINISHED")のまま。
    expect(container.textContent).toContain('FINISHED');

    const row = [...container.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-expanded') === 'false',
    )!;
    await act(async () => row.click());
    expect(container.textContent).toContain('Insert');
    expect(container.textContent).toContain('New cell');
    expect(container.textContent).toContain('Re-run');
  });
});

describe('SavedQueriesPanel: ロケール切替で行アクションと Favorite アクセシブルネームが日英で切り替わる', () => {
  test('ja ロケールでは「お気に入り登録」がお気に入りトグルのアクセシブルネームになる', async () => {
    renderWithLocale('ja', <SavedQueriesPanel search="" />);
    await vi.waitFor(() => expect(container.textContent).toContain('Locale switch query'));
    const favoriteButton = container.querySelector('[aria-label="お気に入り登録"]');
    expect(favoriteButton).not.toBeNull();

    const row = container.querySelector('button[aria-expanded="false"]')!;
    await act(async () => row.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(container.textContent).toContain('挿入');
    expect(container.textContent).toContain('共有');
  });

  test('en ロケールでは "Favorite" がアクセシブルネームのまま', async () => {
    renderWithLocale('en', <SavedQueriesPanel search="" />);
    await vi.waitFor(() => expect(container.textContent).toContain('Locale switch query'));
    const favoriteButton = container.querySelector('[aria-label="Favorite"]');
    expect(favoriteButton).not.toBeNull();

    const row = container.querySelector('button[aria-expanded="false"]')!;
    await act(async () => row.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(container.textContent).toContain('Insert');
    expect(container.textContent).toContain('Share');
  });
});

describe('OperationsPanel: ロケール切替で Kill 操作のラベルとアクセシブルネームが日英で切り替わる', () => {
  test('ja ロケールでは「{owner} のクエリを強制終了」がアクセシブルネームになる', async () => {
    renderWithLocale('ja', <OperationsPanel />);
    await vi.waitFor(() => expect(container.textContent).toContain('operations_demo'));
    const killButton = container.querySelector('[aria-label="alice のクエリを強制終了"]');
    expect(killButton).not.toBeNull();
    expect(container.textContent).toContain('強制終了');
    // state バッジ(item.state === 'running')の表示テキストも翻訳される
    // (QueryStateBadge 経由。common/StateBadge.tsx の生の契約値ではないことの確認)。
    expect(container.textContent).toContain('実行中');
    expect(container.textContent).not.toContain('RUNNING');
  });

  test('en ロケールでは既存どおり "Kill query by alice" のまま', async () => {
    renderWithLocale('en', <OperationsPanel />);
    await vi.waitFor(() => expect(container.textContent).toContain('operations_demo'));
    const killButton = container.querySelector('[aria-label="Kill query by alice"]');
    expect(killButton).not.toBeNull();
    expect(container.textContent).toContain('Kill');
    // state バッジ(item.state === 'running')は en ロケールでは従来どおり
    // 契約値の大文字表記("RUNNING")のまま。
    expect(container.textContent).toContain('RUNNING');
  });
});

describe('NotebookListPanel: 空状態のロケール切替', () => {
  const notebooks: NotebookListItem[] = [];

  test('ja ロケールでは「ノートブックがありません」が表示される', () => {
    renderWithLocale('ja', <NotebookListPanel notebooks={notebooks} />);
    expect(container.textContent).toContain('ノートブックがありません');
  });

  test('en ロケールでは既存どおり "No notebooks" のまま', () => {
    renderWithLocale('en', <NotebookListPanel notebooks={notebooks} />);
    expect(container.textContent).toContain('No notebooks');
  });
});
