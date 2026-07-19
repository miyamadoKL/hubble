// AiPanel の UI 文言が ja/en ロケール切替に追随するかを検証する。パネルの
// aria-label や resize handle の aria-label のように、可視テキストを持たない
// アクセシブルネームは翻訳漏れがあっても他のテストが気付けないため、明示的に確認する。
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AppConfig } from '@hubble/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { LocaleProvider, type Locale } from '../../i18n/locale';

// app config はネットワークを叩かず、テストごとに固定レスポンスを返すフェイクにする。
vi.mock('../../api/client', async () => {
  const actual = await vi.importActual<typeof import('../../api/client')>('../../api/client');
  return {
    ...actual,
    fetchConfig: vi.fn(),
  };
});

import { fetchConfig } from '../../api/client';
import { AiPanel } from './AiPanel';

const config: AppConfig = {
  defaults: { limit: 5000 },
  guard: { enabled: false, maxScanBytes: 0, maxScanBytesHard: 0 },
  ai: { enabled: true, model: null },
} as unknown as AppConfig;

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
  vi.mocked(fetchConfig).mockResolvedValue(config);
});

describe('AiPanel の文言がロケールに追随する', () => {
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

  test('見出し、パネル/リサイズハンドルの aria-label、タスクボタン、空状態文言が日英で切り替わる', async () => {
    await withLocaleAsync('ja', async () => {
      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <LocaleProvider>
              <AiPanel />
            </LocaleProvider>
          </QueryClientProvider>,
        );
      });
    });
    const asideJa = container.querySelector('aside')!;
    expect(asideJa.getAttribute('aria-label')).toBe('AI アシスタントパネル');
    const separatorJa = container.querySelector('[role="separator"]')!;
    expect(separatorJa.getAttribute('aria-label')).toBe('AI パネルの幅を変更');
    expect(container.textContent).toContain('AI アシスタント');
    expect(container.textContent).toContain('説明');
    expect(container.textContent).toContain('エラー修正');
    expect(container.textContent).toContain('下書き');
    expect(container.textContent).toContain('書き換え');
    const closeBtnJa = [...container.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === 'AI パネルを閉じる',
    );
    expect(closeBtnJa).toBeTruthy();
    expect(container.textContent).toContain(
      'SQL セルにフォーカスしてからタスクを選んでください。アシスタントは SQL を提案するだけで、実行は常に通常のエディター操作を経由します。',
    );
    const instructionInputJa = container.querySelector('textarea')!;
    expect(instructionInputJa.getAttribute('placeholder')).toBe(
      '指示（下書きでは必須、書き換えでは任意）…',
    );

    act(() => root.unmount());
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await withLocaleAsync('en', async () => {
      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <LocaleProvider>
              <AiPanel />
            </LocaleProvider>
          </QueryClientProvider>,
        );
      });
    });
    const asideEn = container.querySelector('aside')!;
    expect(asideEn.getAttribute('aria-label')).toBe('AI assistant panel');
    const separatorEn = container.querySelector('[role="separator"]')!;
    expect(separatorEn.getAttribute('aria-label')).toBe('Resize AI panel');
    expect(container.textContent).toContain('AI assistant');
    expect(container.textContent).toContain('Explain');
    expect(container.textContent).toContain('Fix error');
    expect(container.textContent).toContain('Draft');
    expect(container.textContent).toContain('Rewrite');
    const closeBtnEn = [...container.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === 'Close AI panel',
    );
    expect(closeBtnEn).toBeTruthy();
    expect(container.textContent).toContain(
      'Focus a SQL cell, then pick a task. The assistant only proposes SQL; execution always goes through the normal editor flow.',
    );
    const instructionInputEn = container.querySelector('textarea')!;
    expect(instructionInputEn.getAttribute('placeholder')).toBe(
      'Instruction (required for Draft, optional for Rewrite)…',
    );
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
