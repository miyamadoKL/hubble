// GitHub 同期 UI（GitStatusBadge / GitSyncControl / GithubSyncModal）の文言が
// ja/en ロケール切替に追随するかを検証する。GitSyncControl のバッジボタンは
// aria-label / title だけがアクセシブルネームになる（可視テキストを持たない）ため、
// 翻訳漏れがあっても他のテストが気付けない。この観点を明示的に確認する。
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { GithubDocumentStatusResponse, GithubStatusResponse } from '@hubble/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { LocaleProvider, type Locale } from '../../i18n/locale';

// GitHub API はネットワークを叩かず、テストごとに固定レスポンスを返すフェイクにする。
vi.mock('../../api/github', async () => {
  const actual = await vi.importActual<typeof import('../../api/github')>('../../api/github');
  return {
    ...actual,
    getGithubStatus: vi.fn(),
    getDocumentGitStatus: vi.fn(),
  };
});

import { getGithubStatus, getDocumentGitStatus } from '../../api/github';
import { GitSyncControl } from './GitSyncControl';
import { GithubSyncModal } from './GithubSyncModal';

const connectedStatus: GithubStatusResponse = {
  enabled: true,
  connected: true,
  governance: 'off',
};

const modifiedDoc: GithubDocumentStatusResponse = {
  status: 'modified',
  stale: false,
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
  vi.mocked(getGithubStatus).mockResolvedValue(connectedStatus);
  vi.mocked(getDocumentGitStatus).mockResolvedValue(modifiedDoc);
});

describe('GitHub 同期 UI の文言がロケールに追随する', () => {
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

  test('GitSyncControl: バッジボタンの aria-label / title が日英で切り替わる（唯一のアクセシブルネーム）', async () => {
    await withLocaleAsync('ja', async () => {
      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <LocaleProvider>
              <GitSyncControl type="notebook" id="doc-1" documentName="売上集計" />
            </LocaleProvider>
          </QueryClientProvider>,
        );
      });
    });
    await vi.waitFor(() => {
      const btn = container.querySelector('button');
      expect(btn).toBeTruthy();
    });
    const btnJa = container.querySelector('button')!;
    expect(btnJa.getAttribute('aria-label')).toBe('GitHub 同期');
    expect(btnJa.getAttribute('title')).toBe('GitHub 同期');
    // バッジ本体のステータスラベルも翻訳されていること。
    expect(container.textContent).toContain('未反映変更あり');

    act(() => root.unmount());
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await withLocaleAsync('en', async () => {
      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <LocaleProvider>
              <GitSyncControl type="notebook" id="doc-1" documentName="Sales rollup" />
            </LocaleProvider>
          </QueryClientProvider>,
        );
      });
    });
    await vi.waitFor(() => {
      const btn = container.querySelector('button');
      expect(btn).toBeTruthy();
    });
    const btnEn = container.querySelector('button')!;
    expect(btnEn.getAttribute('aria-label')).toBe('GitHub sync');
    expect(btnEn.getAttribute('title')).toBe('GitHub sync');
    expect(container.textContent).toContain('modified');
  });

  test('GithubSyncModal: タイトル、説明文、フッターのボタン文言が日英で切り替わる', async () => {
    await withLocaleAsync('ja', async () => {
      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <LocaleProvider>
              <GithubSyncModal
                open
                type="notebook"
                id="doc-1"
                documentName="売上集計"
                onClose={vi.fn()}
              />
            </LocaleProvider>
          </QueryClientProvider>,
        );
      });
    });
    await vi.waitFor(() => {
      expect(container.textContent).toContain(
        'ローカルの変更はまだ GitHub に反映されていません。push してプルリクエストを開き、レビューを受けてください。',
      );
    });
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('GitHub 同期');
    const pushBtnJa = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'GitHub に push',
    );
    expect(pushBtnJa).toBeTruthy();
    const closeBtnJa = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === '閉じる',
    );
    expect(closeBtnJa).toBeTruthy();

    act(() => root.unmount());
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await withLocaleAsync('en', async () => {
      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <LocaleProvider>
              <GithubSyncModal
                open
                type="notebook"
                id="doc-1"
                documentName="Sales rollup"
                onClose={vi.fn()}
              />
            </LocaleProvider>
          </QueryClientProvider>,
        );
      });
    });
    await vi.waitFor(() => {
      expect(container.textContent).toContain(
        'Local changes are not on GitHub yet. Push and open a pull request to get them reviewed.',
      );
    });
    const dialogEn = container.querySelector('[role="dialog"]')!;
    expect(dialogEn.textContent).toContain('GitHub sync');
    const pushBtnEn = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Push to GitHub',
    );
    expect(pushBtnEn).toBeTruthy();
    const closeBtnEn = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Close',
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
