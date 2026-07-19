// i18n Phase 2a（notebook 領域）の accessible name / 可視ラベルがロケールに追随する
// ことを検証する。パターンは `panels/i18nAccessibleName.test.tsx`（Phase 1）を踏襲する。
//
// 対象コンポーネント: CellToolbar（Monaco 非依存で軽量にレンダーできる）、
// ResultGrid（`ResultGrid.resize.test.tsx` と同じレンダーパターンを使う）、
// SaveQueryModal（既存テストが多いので name 属性ベースで両ロケールを確認する）。
// SqlCell 自体は Monaco の遅延ロードや実行ストアへの依存が大きいため、この観点の
// 検証は CellToolbar（SqlCell が実際に描画する子コンポーネント）で代替する。
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { QueryColumn } from '@hubble/contracts';
import { LocaleProvider, type Locale } from '../../i18n/locale';
import { CellToolbar } from './CellToolbar';
import { ResultGrid } from './ResultGrid';
import { SaveQueryModal } from './SaveQueryModal';
import { StatsStrip } from './StatsStrip';
import { LastRunStrip } from './LastRunStrip';

vi.mock('../../api/savedQueries', () => ({
  createSavedQuery: vi.fn(),
}));
vi.mock('../common/Toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  window.localStorage.clear();
});

/**
 * `navigator.language` を固定して LocaleProvider の初期ロケールを決める
 * （i18nAccessibleName.test.tsx の withLocale と同じ手法）。
 */
function withLocale(locale: Locale, fn: () => void): void {
  Object.defineProperty(window.navigator, 'language', {
    value: locale === 'ja' ? 'ja-JP' : 'en-US',
    configurable: true,
  });
  window.localStorage.clear();
  fn();
}

describe('CellToolbar: aria-label とプレースホルダーがロケールに追随する', () => {
  test('日本語ロケールでは折りたたみボタンと削除ボタンの aria-label が日本語になる', () => {
    withLocale('ja', () => {
      act(() => {
        root.render(
          <LocaleProvider>
            <CellToolbar
              kind="sql"
              collapsed={false}
              onToggleCollapse={vi.fn()}
              onRename={vi.fn()}
            />
          </LocaleProvider>,
        );
      });
    });
    const collapseButton = container.querySelector('button[aria-label]') as HTMLButtonElement;
    expect(collapseButton.getAttribute('aria-label')).toBe('セルを折りたたむ');
    const deleteButton = [...container.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === 'セルを削除',
    );
    expect(deleteButton).toBeTruthy();
  });

  test('英語（既定）ロケールでは折りたたみボタンと削除ボタンの aria-label が英語のまま', () => {
    act(() => {
      root.render(
        <CellToolbar kind="sql" collapsed={false} onToggleCollapse={vi.fn()} onRename={vi.fn()} />,
      );
    });
    const collapseButton = container.querySelector('button[aria-label]') as HTMLButtonElement;
    expect(collapseButton.getAttribute('aria-label')).toBe('Collapse cell');
    const deleteButton = [...container.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === 'Delete cell',
    );
    expect(deleteButton).toBeTruthy();
  });
});

describe('ResultGrid: ツールバーの aria-label と行数フッターがロケールに追随する', () => {
  const columns: QueryColumn[] = [
    { name: 'id', type: 'bigint' },
    { name: 'label', type: 'varchar' },
  ];
  const rows = [
    [1, 'a'],
    [2, 'b'],
  ];
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  test('日本語ロケールでは列表示切替ボタンの aria-label と読み込み済み件数の表示が日本語になる', () => {
    withLocale('ja', () => {
      act(() => {
        root.render(
          <LocaleProvider>
            <QueryClientProvider client={queryClient}>
              <ResultGrid columns={columns} rows={rows} />
            </QueryClientProvider>
          </LocaleProvider>,
        );
      });
    });
    const toggleColumns = [...container.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === '列の表示/非表示',
    );
    expect(toggleColumns).toBeTruthy();
    expect(container.textContent).toContain('2 件読み込み済み');
  });

  test('英語（既定）ロケールでは列表示切替ボタンの aria-label と件数表示が英語のまま', () => {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ResultGrid columns={columns} rows={rows} />
        </QueryClientProvider>,
      );
    });
    const toggleColumns = [...container.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === 'Show / hide columns',
    );
    expect(toggleColumns).toBeTruthy();
    expect(container.textContent).toContain('2 loaded');
  });
});

describe('SaveQueryModal: タイトルとボタン文言がロケールに追随する', () => {
  const datasources = [
    {
      id: 'warehouse-a',
      kind: 'trino' as const,
      displayName: 'Warehouse A',
      capabilities: { costEstimate: true, catalogs: true },
    },
  ];
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  test('日本語ロケールではモーダルタイトルと Name ラベルが日本語になる', () => {
    withLocale('ja', () => {
      act(() => {
        root.render(
          <LocaleProvider>
            <QueryClientProvider client={queryClient}>
              <SaveQueryModal
                open
                statement="SELECT 1"
                context={{ datasourceId: 'warehouse-a' }}
                datasources={datasources}
                onClose={vi.fn()}
              />
            </QueryClientProvider>
          </LocaleProvider>,
        );
      });
    });
    expect(container.textContent).toContain('クエリを保存');
    const nameInput = container.querySelector('[name="name"]') as HTMLInputElement;
    expect(nameInput).toBeTruthy();
    // Name 入力欄は可視ラベル（<label> でラップされた <span>）のテキストで
    // アクセシブルネームが決まるため、そのラベルが翻訳済みであることを確認する。
    const label = nameInput.closest('label');
    expect(label?.querySelector('span')?.textContent).toBe('名前');
  });

  test('英語（既定）ロケールではモーダルタイトルと Name ラベルが英語のまま', () => {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SaveQueryModal
            open
            statement="SELECT 1"
            context={{ datasourceId: 'warehouse-a' }}
            datasources={datasources}
            onClose={vi.fn()}
          />
        </QueryClientProvider>,
      );
    });
    expect(container.textContent).toContain('Save query');
    const nameInput = container.querySelector('[name="name"]') as HTMLInputElement;
    const label = nameInput.closest('label');
    expect(label?.querySelector('span')?.textContent).toBe('Name');
  });
});

// コーディネーターレビュー指摘（P1）: クエリ状態（QueryState）の表示が契約値の
// 生の英語（running/finished 等）のまま表示されていた。queryStateLabel による
// 変換後、ja ロケールで実際に日本語ラベルが表示されることを固定するテスト。
describe('StatsStrip / LastRunStrip: クエリ状態バッジの表示ラベルがロケールに追随する', () => {
  test('日本語ロケールでは StatsStrip の状態バッジが「実行中」になる', () => {
    withLocale('ja', () => {
      act(() => {
        root.render(
          <LocaleProvider>
            <StatsStrip state="running" />
          </LocaleProvider>,
        );
      });
    });
    expect(container.textContent).toContain('実行中');
    expect(container.textContent).not.toMatch(/running/i);
  });

  test('英語（既定）ロケールでは StatsStrip の状態バッジが RUNNING のまま（既存 e2e の大文字一致との後方互換）', () => {
    act(() => {
      root.render(<StatsStrip state="running" />);
    });
    expect(container.textContent).toContain('RUNNING');
  });

  test('日本語ロケールでは LastRunStrip の前回実行状態が「失敗」になる', () => {
    withLocale('ja', () => {
      act(() => {
        root.render(
          <LocaleProvider>
            <LastRunStrip meta={{ state: 'failed', rowCount: 0 }} />
          </LocaleProvider>,
        );
      });
    });
    expect(container.textContent).toContain('失敗');
  });

  test('英語（既定）ロケールでは LastRunStrip の前回実行状態が Failed のまま', () => {
    act(() => {
      root.render(<LastRunStrip meta={{ state: 'failed', rowCount: 0 }} />);
    });
    expect(container.textContent).toContain('Failed');
  });
});
