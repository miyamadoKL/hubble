// レビュー指摘: aria-label は可視ラベルより優先して読み上げられるため、可視ラベルだけ
// 翻訳して aria-label の翻訳を忘れると、支援技術（スクリーンリーダー等）の利用者だけ
// 英語のままになってしまう。この不整合を検出するため、ja ロケールで実際にレンダリング
// した DOM から「アクセシブルネーム」を計算し、日本語になっていることを検証する。
//
// プロジェクトには @testing-library/react 等の a11y 専用ヘルパーが入っていないため、
// このテストファイル専用の最小限の accessible name 計算（aria-labelledby →
// aria-label → 包含する <label> のテキスト、の優先順位のみ）を用意する。汎用の
// ARIA accname 算法の完全な実装ではなく、本テストが必要とする範囲に限定している。
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DatasourceSummary, SavedQuery } from '@hubble/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { LocaleProvider, type Locale } from '../../i18n/locale';

vi.mock('../../hooks/useConfig', () => ({
  useServerTimeZone: vi.fn(() => null),
}));

import { AlertFormModal } from './AlertFormModal';
import { ScheduleFormModal } from './ScheduleFormModal';

const timestamp = '2026-07-12T00:00:00.000Z';

const savedQueries: SavedQuery[] = [
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
    myPermission: 'owner',
  },
];

const datasources: DatasourceSummary[] = [
  {
    id: 'trino-default',
    kind: 'trino',
    displayName: 'Trino (default)',
    capabilities: { costEstimate: true, catalogs: true },
  },
];

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

describe('aria-label / 可視ラベルのアクセシブルネームがロケールに追随する', () => {
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

  test('ScheduleFormModal: Name 入力欄（label ラップ）のアクセシブルネームが日英で切り替わる', () => {
    withLocale('ja', () => {
      act(() =>
        root.render(
          <LocaleProvider>
            <ScheduleFormModal
              open
              schedule={null}
              context={{}}
              datasources={datasources}
              savedQueries={savedQueries}
              submitting={false}
              serverError={null}
              onClose={vi.fn()}
              onCreate={vi.fn()}
              onUpdate={vi.fn()}
            />
          </LocaleProvider>,
        ),
      );
    });
    const nameInput = container.querySelector('[name="name"]')!;
    expect(accessibleName(nameInput)).toBe('名前');

    act(() => root.unmount());
    root = createRoot(container);
    withLocale('en', () => {
      act(() =>
        root.render(
          <LocaleProvider>
            <ScheduleFormModal
              open
              schedule={null}
              context={{}}
              datasources={datasources}
              savedQueries={savedQueries}
              submitting={false}
              serverError={null}
              onClose={vi.fn()}
              onCreate={vi.fn()}
              onUpdate={vi.fn()}
            />
          </LocaleProvider>,
        ),
      );
    });
    const nameInputEn = container.querySelector('[name="name"]')!;
    expect(accessibleName(nameInputEn)).toBe('Name');
  });

  test('ScheduleFormModal: Query source（aria-labelledby）のアクセシブルネームが日英で切り替わる', () => {
    withLocale('ja', () => {
      act(() =>
        root.render(
          <LocaleProvider>
            <ScheduleFormModal
              open
              schedule={null}
              context={{}}
              datasources={datasources}
              savedQueries={savedQueries}
              submitting={false}
              serverError={null}
              onClose={vi.fn()}
              onCreate={vi.fn()}
              onUpdate={vi.fn()}
            />
          </LocaleProvider>,
        ),
      );
    });
    const radiogroup = container.querySelector('[role="radiogroup"][aria-labelledby]')!;
    // aria-label に固定英語文言を持たせていた旧実装は、ここが常に "Query source" の
    // ままになる（＝支援技術利用者だけ英語という不整合）バグを起こしていた。
    expect(accessibleName(radiogroup)).toBe('クエリ');
  });

  test('AlertFormModal: Threshold 入力欄（label ラップ）のアクセシブルネームが日英で切り替わる', () => {
    withLocale('ja', () => {
      act(() =>
        root.render(
          <LocaleProvider>
            <AlertFormModal
              open
              alert={null}
              savedQueries={savedQueries}
              submitting={false}
              onClose={vi.fn()}
              onCreate={vi.fn()}
              onUpdate={vi.fn()}
            />
          </LocaleProvider>,
        ),
      );
    });
    // AlertFormModal の Threshold input は name 属性を持たないため、FIELD_LABEL
    // span のテキストで label を特定し、直後の input を取得する。
    const label = [...container.querySelectorAll('label')].find(
      (l) => l.querySelector('span')?.textContent === 'しきい値',
    )!;
    const input = label.querySelector('input')!;
    expect(accessibleName(input)).toBe('しきい値');

    act(() => root.unmount());
    root = createRoot(container);
    withLocale('en', () => {
      act(() =>
        root.render(
          <LocaleProvider>
            <AlertFormModal
              open
              alert={null}
              savedQueries={savedQueries}
              submitting={false}
              onClose={vi.fn()}
              onCreate={vi.fn()}
              onUpdate={vi.fn()}
            />
          </LocaleProvider>,
        ),
      );
    });
    const labelEn = [...container.querySelectorAll('label')].find(
      (l) => l.querySelector('span')?.textContent === 'Threshold',
    )!;
    const inputEn = labelEn.querySelector('input')!;
    expect(accessibleName(inputEn)).toBe('Threshold');
  });

  test('ScheduleBuilder: Schedule frequency（単独 aria-label）のアクセシブルネームが日英で切り替わる', () => {
    withLocale('ja', () => {
      act(() =>
        root.render(
          <LocaleProvider>
            <ScheduleFormModal
              open
              schedule={null}
              context={{}}
              datasources={datasources}
              savedQueries={savedQueries}
              submitting={false}
              serverError={null}
              onClose={vi.fn()}
              onCreate={vi.fn()}
              onUpdate={vi.fn()}
            />
          </LocaleProvider>,
        ),
      );
    });
    const frequencyGroup = [
      ...container.querySelectorAll('[data-testid="schedule-builder"] [role="radiogroup"]'),
    ][0]!;
    expect(accessibleName(frequencyGroup)).toBe('スケジュールの頻度');
  });
});
