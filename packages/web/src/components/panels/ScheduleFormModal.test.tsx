// ScheduleFormModal の保存済みクエリピッカーと送信ペイロードの組み立てを検証する。
// schedule は常に savedQueryId 参照のみを持ち（SQL 直書きは廃止済み）、cron
// ビルダー自体の変換ロジックは scheduleCron.test.ts でカバーしているため、ここでは
// フォームの配線のみを見る。
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DatasourceSummary, SavedQuery, Schedule } from '@hubble/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { useServerTimeZone } from '../../hooks/useConfig';

// ScheduleBuilder が useServerTimeZone（GET /api/config 経由）を呼ぶため、
// このファイルのテストではネットワーク往復を避けるためにモックする。
// 既定は未取得（null）を返し、タイムゾーン表示自体を検証するテストだけ個別に上書きする。
vi.mock('../../hooks/useConfig', () => ({
  useServerTimeZone: vi.fn(() => null),
}));

import { ScheduleFormModal } from './ScheduleFormModal';

const timestamp = '2026-07-12T00:00:00.000Z';

const datasources: DatasourceSummary[] = [
  {
    id: 'trino-default',
    kind: 'trino',
    displayName: 'Trino (default)',
    capabilities: { costEstimate: true, catalogs: true },
  },
  {
    id: 'mysql-analytics',
    kind: 'mysql',
    displayName: 'MySQL analytics',
    capabilities: { costEstimate: false, catalogs: false },
  },
];

const savedQueries: SavedQuery[] = [
  {
    id: 'saved-1',
    name: 'Nightly totals',
    description: '',
    statement: 'SELECT count(*) FROM tpch.tiny.nation',
    catalog: 'tpch',
    schema: 'tiny',
    datasourceId: 'trino-default',
    isFavorite: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    myPermission: 'owner',
  },
  {
    id: 'saved-2',
    name: 'Analytics rollup',
    description: '',
    statement: 'SELECT * FROM sales.rollup',
    catalog: 'sales',
    schema: 'rollup',
    datasourceId: 'mysql-analytics',
    isFavorite: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    myPermission: 'owner',
  },
];

function schedule(over: Partial<Schedule> = {}): Schedule {
  return {
    id: 'sch-1',
    name: 'Existing schedule',
    savedQueryId: 'saved-1',
    cron: '0 9 * * *',
    enabled: true,
    retry: { maxAttempts: 3, backoffSeconds: 60, backoffMultiplier: 2 },
    notifications: { onFailure: false, channels: [] },
    createdAt: timestamp,
    updatedAt: timestamp,
    nextRunAt: null,
    lastRun: null,
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

describe('ScheduleFormModal: 保存済みクエリピッカーと送信ペイロード', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.mocked(useServerTimeZone).mockReturnValue(null);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function clickSave(label = 'Create schedule'): void {
    const save = [...container.querySelectorAll('button')].find((b) => b.textContent === label);
    act(() => save!.click());
  }

  // React は input/textarea の value を独自のプロパティディスクリプタで追跡しているため、
  // DOM の value を直接書き換えて input イベントを投げただけでは onChange が発火しない。
  // ネイティブの setter 経由で書き込むことで、React 管理下でも変更を検知させる。
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

  function setSelectValue(select: HTMLSelectElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLSelectElement.prototype,
      'value',
    )!.set!;
    act(() => {
      setter.call(select, value);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  test('新規作成では保存済みクエリピッカーだけが表示される（SQL 直書き欄は無い）', () => {
    act(() =>
      root.render(
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
        />,
      ),
    );
    expect(container.querySelector('[aria-label="SQL statement"]')).toBeNull();
    expect(container.querySelector('[aria-label="Saved query"]')).not.toBeNull();
    // 先頭の saved query が既定選択され、SQL プレビューに反映されている。
    expect(container.textContent).toContain('SELECT count(*) FROM tpch.tiny.nation');
  });

  test('作成すると name と savedQueryId のみを含むリクエストを送る', () => {
    const onCreate = vi.fn();
    act(() =>
      root.render(
        <ScheduleFormModal
          open
          schedule={null}
          datasources={datasources}
          savedQueries={savedQueries}
          submitting={false}
          serverError={null}
          onClose={vi.fn()}
          onCreate={onCreate}
          onUpdate={vi.fn()}
        />,
      ),
    );
    const nameInput = container.querySelector('[name="name"]') as HTMLInputElement;
    typeInto(nameInput, 'My schedule');
    clickSave('Create schedule');

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'My schedule', savedQueryId: 'saved-1' }),
    );
    const body = onCreate.mock.calls[0]![0];
    expect(body.statement).toBeUndefined();
    expect(body.catalog).toBeUndefined();
    expect(body.schema).toBeUndefined();
    expect(body.datasourceId).toBeUndefined();
  });

  test('保存済みクエリを選び直すと送信される savedQueryId とプレビューが切り替わる', () => {
    const onCreate = vi.fn();
    act(() =>
      root.render(
        <ScheduleFormModal
          open
          schedule={null}
          datasources={datasources}
          savedQueries={savedQueries}
          submitting={false}
          serverError={null}
          onClose={vi.fn()}
          onCreate={onCreate}
          onUpdate={vi.fn()}
        />,
      ),
    );
    const select = container.querySelector('[aria-label="Saved query"]') as HTMLSelectElement;
    setSelectValue(select, 'saved-2');
    expect(container.textContent).toContain('SELECT * FROM sales.rollup');
    expect(container.textContent).toContain('MySQL analytics');

    const nameInput = container.querySelector('[name="name"]') as HTMLInputElement;
    typeInto(nameInput, 'Rollup schedule');
    clickSave('Create schedule');

    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ savedQueryId: 'saved-2' }));
  });

  test('既存スケジュールの編集は現在参照している保存済みクエリで開く', () => {
    act(() =>
      root.render(
        <ScheduleFormModal
          open
          schedule={schedule({ savedQueryId: 'saved-2' })}
          datasources={datasources}
          savedQueries={savedQueries}
          submitting={false}
          serverError={null}
          onClose={vi.fn()}
          onCreate={vi.fn()}
          onUpdate={vi.fn()}
        />,
      ),
    );
    const select = container.querySelector('[aria-label="Saved query"]') as HTMLSelectElement;
    expect(select.value).toBe('saved-2');
    expect(container.textContent).toContain('SELECT * FROM sales.rollup');
  });

  // 指摘1: saved query 一覧の取得が完了する前にモーダルを開くと、初回マウント時点では
  // savedQueries が空配列になる。一覧が後から届いたときに選択が復旧しない回帰を防ぐ。
  test('saved query 一覧が非同期に届いた場合、未選択のまま先頭候補へ復旧する', () => {
    act(() =>
      root.render(
        <ScheduleFormModal
          open
          schedule={null}
          datasources={datasources}
          savedQueries={[]}
          submitting={false}
          serverError={null}
          onClose={vi.fn()}
          onCreate={vi.fn()}
          onUpdate={vi.fn()}
        />,
      ),
    );
    // 一覧が空の間は「保存済みクエリがまだない」メッセージが出て、select は描画されない。
    expect(container.querySelector('[aria-label="Saved query"]')).toBeNull();

    // savedQueries が非同期に届く（open / schedule は変わらないため ScheduleFormModalBody は
    // 再マウントされず、key ベースのリセットに頼らずに復旧できる必要がある）。
    act(() =>
      root.render(
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
        />,
      ),
    );
    const select = container.querySelector('[aria-label="Saved query"]') as HTMLSelectElement;
    expect(select).not.toBeNull();
    expect(select.value).toBe('saved-1');
  });

  // 指摘3: server は cron を server local timezone で評価するため、読み下しに
  // その基準を常時明記する。未取得の間のフォールバック表示も確認する。
  test('cron の読み下しに server timezone を明記する（未取得なら「サーバー時刻基準」）', () => {
    act(() =>
      root.render(
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
        />,
      ),
    );
    // ScheduleBuilder は locale 未設定時（LocaleProvider の外側）は英語がデフォルトになる。
    expect(container.textContent).toContain('server time basis');

    vi.mocked(useServerTimeZone).mockReturnValue('Asia/Tokyo');
    act(() =>
      root.render(
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
        />,
      ),
    );
    expect(container.textContent).toContain('server time: Asia/Tokyo');
  });
});
