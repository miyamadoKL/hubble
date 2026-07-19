// AddWidgetModal / DashboardsPanel の UI 文言が ja/en ロケール切替に追随するかを検証する。
// aria-label だけが唯一のアクセシブルネームになる箇所（widget カード内の
// リフレッシュ/削除アイコンボタン等は WidgetCard.test.tsx 側でカバーされるため、
// ここではモーダル/パネルの可視文言中心に、翻訳漏れを検出できる形で確認する。
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DashboardListItem, SavedQueryResponse } from '@hubble/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { LocaleProvider, type Locale } from '../../i18n/locale';

// 保存済みクエリ一覧 API はネットワークを叩かず、テストごとに固定レスポンスを返す。
vi.mock('../../api/savedQueries', () => ({
  listSavedQueries: vi.fn(),
}));

// ダッシュボード一覧 API も同様にフェイク化する。
vi.mock('../../api/dashboards', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/dashboards')>('../../api/dashboards');
  return {
    ...actual,
    listDashboards: vi.fn(),
  };
});

import { listSavedQueries } from '../../api/savedQueries';
import { listDashboards } from '../../api/dashboards';
import { AddWidgetModal } from './AddWidgetModal';
import { DashboardsPanel } from './DashboardsPanel';

const timestamp = '2026-07-12T00:00:00.000Z';

const savedQueries: SavedQueryResponse[] = [
  {
    id: 'saved-1',
    name: 'Row count',
    description: '',
    statement: 'SELECT count(*) AS n FROM tpch.tiny.nation',
    catalog: 'tpch',
    schema: 'tiny',
    isFavorite: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    owner: 'me',
    myPermission: 'owner',
  },
];

const dashboardItem: DashboardListItem = {
  id: 'dash-1',
  name: 'Sales overview',
  description: '',
  widgetCount: 3,
  updatedAt: timestamp,
  createdAt: timestamp,
  owner: 'me',
  myPermission: 'owner',
};

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

beforeEach(() => {
  vi.mocked(listSavedQueries).mockResolvedValue(savedQueries);
  vi.mocked(listDashboards).mockResolvedValue([dashboardItem]);
});

// ロケールごとに固定 navigator.language を張って LocaleProvider の初期値を決める
// （localStorage は各テストで clear 済み、principalStorageKey は test mode で
// unscoped キーを返すため、他テストの副作用は残らない）。
async function withLocaleAsync(locale: Locale, fn: () => Promise<void>): Promise<void> {
  Object.defineProperty(window.navigator, 'language', {
    value: locale === 'ja' ? 'ja-JP' : 'en-US',
    configurable: true,
  });
  window.localStorage.clear();
  await fn();
}

describe('AddWidgetModal / DashboardsPanel の UI 文言がロケールに追随する', () => {
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
  });

  test('AddWidgetModal: タイトル、ラベル、ボタン文言が日英で切り替わる', async () => {
    await withLocaleAsync('ja', async () => {
      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <LocaleProvider>
              <AddWidgetModal open onClose={vi.fn()} onAdd={vi.fn()} />
            </LocaleProvider>
          </QueryClientProvider>,
        );
      });
    });
    expect(container.querySelector('h2')?.textContent).toBe('ウィジェットを追加');
    expect(container.textContent).toContain('種別');
    expect(container.textContent).toContain('保存済みクエリ');
    expect(container.textContent).toContain('表示形式');
    const addButton = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === '追加',
    );
    expect(addButton).toBeTruthy();

    act(() => root.unmount());
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await withLocaleAsync('en', async () => {
      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <LocaleProvider>
              <AddWidgetModal open onClose={vi.fn()} onAdd={vi.fn()} />
            </LocaleProvider>
          </QueryClientProvider>,
        );
      });
    });
    expect(container.querySelector('h2')?.textContent).toBe('Add widget');
    expect(container.textContent).toContain('Type');
    expect(container.textContent).toContain('Saved query');
    expect(container.textContent).toContain('Display as');
    const addButtonEn = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Add',
    );
    expect(addButtonEn).toBeTruthy();
  });

  test('DashboardsPanel: 新規作成ボタンと widget 件数表示が日英で切り替わる', async () => {
    await withLocaleAsync('ja', async () => {
      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <LocaleProvider>
              <DashboardsPanel search="" />
            </LocaleProvider>
          </QueryClientProvider>,
        );
      });
    });
    await vi.waitFor(() => {
      expect(container.textContent).toContain('新規ダッシュボード');
    });
    expect(container.textContent).toContain('3 件のウィジェット');

    act(() => root.unmount());
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await withLocaleAsync('en', async () => {
      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <LocaleProvider>
              <DashboardsPanel search="" />
            </LocaleProvider>
          </QueryClientProvider>,
        );
      });
    });
    await vi.waitFor(() => {
      expect(container.textContent).toContain('New dashboard');
    });
    expect(container.textContent).toContain('3 widgets');
  });
});
