// レビュー指摘: aria-label は可視ラベルより優先して読み上げられるため、可視ラベルだけ
// 翻訳して aria-label の翻訳を忘れると、支援技術（スクリーンリーダー等）の利用者だけ
// 英語のままになってしまう。この不整合を検出するため、ja/en ロケールで実際にレンダリング
// した DOM から可視テキストとアクセシブルネームを取得し、ロケール追随を検証する。
//
// パターンは components/panels/i18nAccessibleName.test.tsx を踏襲する（このテストファイル
// 専用の最小限のアクセシブルネーム計算: aria-labelledby → aria-label → 包含する <label> の
// テキスト、の優先順位のみ）。
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DatasourceSummary, WorkflowRunStatus } from '@hubble/contracts';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { LocaleProvider, type Locale } from '../../i18n/locale';
import { WorkflowSettingsModal } from './WorkflowSettingsModal';
import { WorkflowStatusBadge } from './WorkflowStatusBadge';
import type { WorkflowDraft } from './workflowFormat';

const datasources: DatasourceSummary[] = [
  {
    id: 'trino-default',
    kind: 'trino',
    displayName: 'Trino (default)',
    capabilities: { costEstimate: true, catalogs: true },
  },
];

const draft: WorkflowDraft = {
  name: 'Morning report',
  description: '',
  datasourceId: 'trino-default',
  cron: null,
  enabled: true,
  stages: [{ steps: [] }],
};

/**
 * `el` のアクセシブルネームを、以下の優先順位のみで計算する（本テスト用の簡易版）:
 *   1. aria-labelledby が指す要素の textContent
 *   2. aria-label 属性
 *   3. 祖先の <label> 要素の textContent（label 内に別要素があっても丸ごと含む簡易実装）
 * 該当が無ければ null を返す。
 */
function accessibleName(el: Element): string | null {
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const labelEl = el.ownerDocument.getElementById(labelledBy);
    if (labelEl?.textContent) return labelEl.textContent.trim();
  }
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel;
  const label = el.closest('label');
  if (label?.textContent) return label.textContent.trim();
  return null;
}

// ロケールごとに固定 navigator.language を張って LocaleProvider の初期値を決める
// （localStorage は各テストで clear 済み、principalStorageKey は test mode で
// unscoped キーを返すため、他テストの副作用は残らない）。
function withLocale(locale: Locale, fn: () => void): void {
  Object.defineProperty(window.navigator, 'language', {
    value: locale === 'ja' ? 'ja-JP' : 'en-US',
    configurable: true,
  });
  window.localStorage.clear();
  fn();
}

describe('workflow コンポーネントの可視テキストと aria-label がロケールに追随する', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  test('WorkflowSettingsModal: タイトルと Description ラベルが日英で切り替わる', () => {
    withLocale('ja', () => {
      act(() =>
        root.render(
          <LocaleProvider>
            <WorkflowSettingsModal
              open
              draft={draft}
              datasources={datasources}
              onApply={vi.fn()}
              onClose={vi.fn()}
            />
          </LocaleProvider>,
        ),
      );
    });
    expect(container.textContent).toContain('ワークフロー設定');
    const descriptionLabel = [...container.querySelectorAll('label')].find(
      (l) => l.querySelector('span')?.textContent === '説明',
    );
    expect(descriptionLabel).toBeTruthy();

    act(() => root.unmount());
    root = createRoot(container);
    withLocale('en', () => {
      act(() =>
        root.render(
          <LocaleProvider>
            <WorkflowSettingsModal
              open
              draft={draft}
              datasources={datasources}
              onApply={vi.fn()}
              onClose={vi.fn()}
            />
          </LocaleProvider>,
        ),
      );
    });
    expect(container.textContent).toContain('Workflow settings');
    const descriptionLabelEn = [...container.querySelectorAll('label')].find(
      (l) => l.querySelector('span')?.textContent === 'Description',
    );
    expect(descriptionLabelEn).toBeTruthy();
  });

  test('WorkflowSettingsModal: スケジュール有効/無効トグル（単独 aria-label）が日英で切り替わる', () => {
    const cronDraft: WorkflowDraft = { ...draft, cron: '0 9 * * *' };
    withLocale('ja', () => {
      act(() =>
        root.render(
          <LocaleProvider>
            <WorkflowSettingsModal
              open
              draft={cronDraft}
              datasources={datasources}
              onApply={vi.fn()}
              onClose={vi.fn()}
            />
          </LocaleProvider>,
        ),
      );
    });
    const toggle = container.querySelector('[role="switch"]')!;
    // draft.enabled === true のため、押すと「無効化」する意味の aria-label になる。
    expect(accessibleName(toggle)).toBe('スケジュールを無効化');

    act(() => root.unmount());
    root = createRoot(container);
    withLocale('en', () => {
      act(() =>
        root.render(
          <LocaleProvider>
            <WorkflowSettingsModal
              open
              draft={cronDraft}
              datasources={datasources}
              onApply={vi.fn()}
              onClose={vi.fn()}
            />
          </LocaleProvider>,
        ),
      );
    });
    const toggleEn = container.querySelector('[role="switch"]')!;
    expect(accessibleName(toggleEn)).toBe('Disable schedule');
  });

  test.each<[WorkflowRunStatus, string, string]>([
    ['running', '実行中', 'running'],
    ['partial', '一部成功', 'partial'],
    ['failed', '失敗', 'failed'],
  ])('WorkflowStatusBadge: status=%s のラベルが日英で切り替わる', (status, jaLabel, enLabel) => {
    withLocale('ja', () => {
      act(() =>
        root.render(<LocaleProvider>{<WorkflowStatusBadge status={status} />}</LocaleProvider>),
      );
    });
    expect(container.textContent).toBe(jaLabel);

    act(() => root.unmount());
    root = createRoot(container);
    withLocale('en', () => {
      act(() =>
        root.render(<LocaleProvider>{<WorkflowStatusBadge status={status} />}</LocaleProvider>),
      );
    });
    expect(container.textContent).toBe(enLabel);
  });
});
