// i18n フェーズ 2c（CommandPalette）: コマンド名、グループ見出し、検索欄の
// プレースホルダー、ダイアログ/閉じるボタンのアクセシブルネームが、
// LocaleProvider のロケールに応じて日本語/英語で切り替わることを確認する。
// キーボードショートカット表示（"Ctrl"/"S" 等）は対象外（スコープ外の指示どおり）。
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { LocaleProvider, type Locale } from '../../i18n/locale';
import { useUiStore } from '../../stores/uiStore';

vi.mock('../../api/notebooks', () => ({
  listNotebooks: vi.fn(async () => []),
  getNotebook: vi.fn(),
}));

import { CommandPalette } from './CommandPalette';

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
  useUiStore.setState({ paletteOpen: true, theme: 'light', presentationMode: false });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useUiStore.setState({ paletteOpen: false });
  vi.clearAllMocks();
});

function renderPalette(locale: Locale) {
  withLocale(locale, () => {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <LocaleProvider>
            <CommandPalette context={{ catalog: '', schema: '' }} defaultLimit={50} />
          </LocaleProvider>
        </QueryClientProvider>,
      );
    });
  });
}

describe('CommandPalette: ロケール切替でコマンド名/グループ見出しが日英で切り替わる', () => {
  test('ja ロケールでは日本語のコマンド名/グループ見出しが表示される', () => {
    renderPalette('ja');
    expect(container.textContent).toContain('全セルを実行');
    expect(container.textContent).toContain('ノートブックを保存');
    expect(container.textContent).toContain('クエリ');
    expect(container.textContent).toContain('表示');
    const input = container.querySelector('input')!;
    expect(input.getAttribute('placeholder')).toBe('コマンドを入力…');
  });

  test('en ロケールでは既存どおり英語のコマンド名/グループ見出しのまま', () => {
    renderPalette('en');
    expect(container.textContent).toContain('Run all cells');
    expect(container.textContent).toContain('Save notebook');
    expect(container.textContent).toContain('Query');
    expect(container.textContent).toContain('Appearance');
    const input = container.querySelector('input')!;
    expect(input.getAttribute('placeholder')).toBe('Type a command…');
  });
});

describe('CommandPalette: ダイアログ/閉じるボタンのアクセシブルネームが日英で切り替わる', () => {
  test('ja ロケールでは「コマンドパレット」「コマンドパレットを閉じる」になる', () => {
    renderPalette('ja');
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-label')).toBe('コマンドパレット');
    const closeButton = container.querySelector('[aria-label="コマンドパレットを閉じる"]');
    expect(closeButton).not.toBeNull();
  });

  test('en ロケールでは既存どおり "Command palette" / "Close command palette" のまま', () => {
    renderPalette('en');
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-label')).toBe('Command palette');
    const closeButton = container.querySelector('[aria-label="Close command palette"]');
    expect(closeButton).not.toBeNull();
  });
});
