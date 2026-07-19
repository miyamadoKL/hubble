// SchemaTree / TableDetailPopover の UI 文言が ja/en ロケール切替に追随するかを検証する。
// aria-label だけが唯一のアクセシブルネームになる箇所（「詳細」アイコンボタン、
// テーブル詳細ダイアログ、閉じるボタン）は、可視テキストの翻訳漏れがあっても
// テストが気付けないため、accessible name を明示的に読み取って確認する。
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CatalogsResponse, TableDetail, SampleRowsResponse } from '@hubble/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { LocaleProvider, type Locale } from '../../i18n/locale';

// メタデータ API はネットワークを叩かず、テストごとに固定レスポンスを返すフェイクにする。
vi.mock('../../api/metadata', async () => {
  const actual = await vi.importActual<typeof import('../../api/metadata')>('../../api/metadata');
  return {
    ...actual,
    fetchCatalogs: vi.fn(),
    fetchSchemas: vi.fn(),
    fetchTables: vi.fn(),
    fetchTableDetail: vi.fn(),
    fetchTableSample: vi.fn(),
    refreshMetadata: vi.fn(),
  };
});

import { fetchCatalogs, fetchTableDetail, fetchTableSample } from '../../api/metadata';
import { SchemaTree } from './SchemaTree';
import { TableDetailPopover, type TableTarget } from './TableDetailPopover';

const timestamp = '2026-07-12T00:00:00.000Z';

const emptyCatalogs: CatalogsResponse = {
  items: [],
  source: 'cache',
  stale: false,
  lastUpdatedAt: timestamp,
};

const tableDetail: TableDetail = {
  catalog: 'tpch',
  schema: 'tiny',
  name: 'orders',
  columns: [{ name: 'orderkey', type: 'bigint' }],
};

const sample: SampleRowsResponse = {
  columns: [{ name: 'orderkey', type: 'bigint' }],
  rows: [],
  source: 'cache',
};

const target: TableTarget = { catalog: 'tpch', schema: 'tiny', name: 'orders', type: 'TABLE' };

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
  vi.mocked(fetchCatalogs).mockResolvedValue(emptyCatalogs);
  vi.mocked(fetchTableDetail).mockResolvedValue(tableDetail);
  vi.mocked(fetchTableSample).mockResolvedValue(sample);
});

describe('SchemaTree / TableDetailPopover の UI 文言がロケールに追随する', () => {
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

  test('SchemaTree: 空状態とリフレッシュボタンのラベルが日英で切り替わる', async () => {
    await withLocaleAsync('ja', async () => {
      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <LocaleProvider>
              <SchemaTree datasourceId="trino-default" />
            </LocaleProvider>
          </QueryClientProvider>,
        );
      });
    });
    await vi.waitFor(() => {
      expect(container.textContent).toContain('カタログなし');
    });
    const refreshBtn = [...container.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === 'メタデータを更新',
    );
    expect(refreshBtn).toBeTruthy();

    act(() => root.unmount());
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await withLocaleAsync('en', async () => {
      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <LocaleProvider>
              <SchemaTree datasourceId="trino-default" />
            </LocaleProvider>
          </QueryClientProvider>,
        );
      });
    });
    await vi.waitFor(() => {
      expect(container.textContent).toContain('No catalogs');
    });
    const refreshBtnEn = [...container.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === 'Refresh metadata',
    );
    expect(refreshBtnEn).toBeTruthy();
  });

  test('TableDetailPopover: ダイアログの aria-label、見出し、ボタン文言が日英で切り替わる', async () => {
    await withLocaleAsync('ja', async () => {
      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <LocaleProvider>
              <TableDetailPopover
                target={target}
                context={{}}
                datasourceId="trino-default"
                onClose={vi.fn()}
              />
            </LocaleProvider>
          </QueryClientProvider>,
        );
      });
    });
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-label')).toBe('orders の詳細');
    expect(container.textContent).toContain('カラム');
    expect(container.textContent).toContain('SELECT テンプレート');
    const closeBtn = [...container.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === '閉じる',
    );
    expect(closeBtn).toBeTruthy();

    act(() => root.unmount());
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await withLocaleAsync('en', async () => {
      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <LocaleProvider>
              <TableDetailPopover
                target={target}
                context={{}}
                datasourceId="trino-default"
                onClose={vi.fn()}
              />
            </LocaleProvider>
          </QueryClientProvider>,
        );
      });
    });
    const dialogEn = container.querySelector('[role="dialog"]')!;
    expect(dialogEn.getAttribute('aria-label')).toBe('orders details');
    expect(container.textContent).toContain('Columns');
    expect(container.textContent).toContain('SELECT template');
    const closeBtnEn = [...container.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === 'Close',
    );
    expect(closeBtnEn).toBeTruthy();
  });
});

// withLocale は同期関数だが、act(async () => ...) の内側で navigator.language を
// 張り替えたいテストのために async 版のラッパーを用意する（fn 自体は非同期）。
async function withLocaleAsync(locale: Locale, fn: () => Promise<void>): Promise<void> {
  Object.defineProperty(window.navigator, 'language', {
    value: locale === 'ja' ? 'ja-JP' : 'en-US',
    configurable: true,
  });
  window.localStorage.clear();
  await fn();
}
