// AlertFormModal に埋め込まれた共通スケジュールビルダー（ScheduleBuilder）の
// モード切替が、送信ペイロードの cron フィールドへ正しく反映されることを検証する。
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Alert, SavedQuery } from '@hubble/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

// ScheduleBuilder が useServerTimeZone（GET /api/config 経由）を呼ぶため、
// このファイルのテストではネットワーク往復を避けるためにモックする。
vi.mock('../../hooks/useConfig', () => ({
  useServerTimeZone: vi.fn(() => null),
}));

import { AlertFormModal } from './AlertFormModal';

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

function alert(over: Partial<Alert> = {}): Alert {
  return {
    id: 'alert-1',
    name: 'Existing alert',
    savedQueryId: 'saved-1',
    columnName: 'n',
    op: '>',
    value: '0',
    selector: 'first',
    rearm: 0,
    muted: false,
    cron: '0 9 * * 1,3',
    state: 'unknown',
    lastTriggeredAt: null,
    notifications: { channels: [] },
    createdAt: timestamp,
    updatedAt: timestamp,
    nextEvalAt: null,
    ...over,
  };
}

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

describe('AlertFormModal: スケジュールビルダーのモード切替と送信ペイロード', () => {
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

  function radio(label: string): HTMLButtonElement {
    const found = [...container.querySelectorAll('button[role="radio"]')].find(
      (b) => b.textContent === label,
    );
    if (!found) throw new Error(`radio "${label}" not found`);
    return found as HTMLButtonElement;
  }

  function typeInto(el: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!;
    act(() => {
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  test('既存 alert の cron (曜日リスト) を毎週モードとして復元する', () => {
    act(() =>
      root.render(
        <AlertFormModal
          open
          alert={alert({ cron: '0 9 * * 1,3' })}
          savedQueries={savedQueries}
          submitting={false}
          onClose={vi.fn()}
          onCreate={vi.fn()}
          onUpdate={vi.fn()}
        />,
      ),
    );
    // ScheduleBuilder は locale 未設定時（LocaleProvider の外側）は英語がデフォルトになる。
    expect(radio('Weekly').getAttribute('aria-checked')).toBe('true');
    // 月(1)と水(3)が選択済みで表示される（英語ロケールでは Mon/Wed 表記）。
    const monday = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Mon');
    const wednesday = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Wed',
    );
    expect(monday!.getAttribute('aria-pressed')).toBe('true');
    expect(wednesday!.getAttribute('aria-pressed')).toBe('true');
  });

  test('毎時モードへ切り替えて分を指定すると、その cron で送信される', () => {
    const onUpdate = vi.fn();
    act(() =>
      root.render(
        <AlertFormModal
          open
          alert={alert()}
          savedQueries={savedQueries}
          submitting={false}
          onClose={vi.fn()}
          onCreate={vi.fn()}
          onUpdate={onUpdate}
        />,
      ),
    );
    act(() => radio('Hourly').click());
    // aria-label は可視ラベルとの重複を避けるため削除済み（レビュー指摘）。
    // input の name 属性で特定する。
    const minuteInput = container.querySelector('[name="minute"]') as HTMLInputElement;
    typeInto(minuteInput, '20');

    const save = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Save');
    act(() => save!.click());

    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ cron: '20 * * * *' }));
  });

  test('カスタムモードで cron を直接入力して送信できる', () => {
    const onUpdate = vi.fn();
    act(() =>
      root.render(
        <AlertFormModal
          open
          alert={alert()}
          savedQueries={savedQueries}
          submitting={false}
          onClose={vi.fn()}
          onCreate={vi.fn()}
          onUpdate={onUpdate}
        />,
      ),
    );
    act(() => radio('Custom (cron)').click());
    const cronInput = container.querySelector('[name="cron"]') as HTMLInputElement;
    typeInto(cronInput, '*/15 * * * *');

    const save = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Save');
    act(() => save!.click());

    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ cron: '*/15 * * * *' }));
  });
});
