// i18n 第 1 フェーズ（Schedule / Alert 領域）の代表的なラベルが、LocaleProvider の
// ロケールに応じて日本語/英語で切り替わることを確認する。ユーザー指摘の起点になった
// AlertFormModal の「THRESHOLD」（しきい値）ラベルを中心に、Schedule 側も 1 件確認する。
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

describe('AlertFormModal: ロケール切替でラベルが日英で切り替わる', () => {
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

  function renderAlertForm() {
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
  }

  test('ja ロケールでは「しきい値」ラベルが表示される（英語 THRESHOLD の直訳ではなく非エンジニア向け訳）', () => {
    withLocale('ja', renderAlertForm);
    expect(container.textContent).toContain('しきい値');
    expect(container.textContent).not.toContain('Threshold');
  });

  test('en ロケールでは既存どおり Threshold のまま（英語表記の後退がない）', () => {
    withLocale('en', renderAlertForm);
    expect(container.textContent).toContain('Threshold');
    expect(container.textContent).not.toContain('しきい値');
  });
});

describe('ScheduleFormModal: ロケール切替でラベルが日英で切り替わる', () => {
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

  function renderScheduleForm() {
    act(() =>
      root.render(
        <LocaleProvider>
          <ScheduleFormModal
            open
            schedule={null}
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
  }

  test('ja ロケールでは「有効」「新規スケジュール」ラベルが表示される', () => {
    withLocale('ja', renderScheduleForm);
    expect(container.textContent).toContain('新規スケジュール');
    expect(container.textContent).toContain('有効');
  });

  test('en ロケールでは既存どおり "New schedule" / "Enabled" のまま', () => {
    withLocale('en', renderScheduleForm);
    expect(container.textContent).toContain('New schedule');
    expect(container.textContent).toContain('Enabled');
  });
});
