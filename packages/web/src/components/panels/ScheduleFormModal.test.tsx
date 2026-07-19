// ScheduleFormModal のクエリ入力モード（saved query 参照 / SQL 直接入力）切替と、
// 送信ペイロードの組み立てを検証する。cron ビルダー自体の変換ロジックは
// scheduleCron.test.ts でカバーしているため、ここではフォームの配線のみを見る。
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
    statement: 'SELECT 1',
    savedQueryId: null,
    catalog: 'catalog',
    schema: 'schema',
    cron: '0 9 * * *',
    enabled: true,
    retry: { maxAttempts: 3, backoffSeconds: 60, backoffMultiplier: 2 },
    notifications: { onFailure: false, channels: [] },
    createdAt: timestamp,
    updatedAt: timestamp,
    nextRunAt: null,
    lastRun: null,
    datasourceId: 'trino-default',
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

describe('ScheduleFormModal: クエリ入力モードと送信ペイロード', () => {
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

  function radio(label: string): HTMLButtonElement {
    const found = [...container.querySelectorAll('button[role="radio"]')].find(
      (b) => b.textContent === label,
    );
    if (!found) throw new Error(`radio "${label}" not found`);
    return found as HTMLButtonElement;
  }

  function clickSave(label = 'Create schedule'): void {
    const save = [...container.querySelectorAll('button')].find((b) => b.textContent === label);
    act(() => save!.click());
  }

  // React は input/textarea の value を独自のプロパティディスクリプタで追跡しているため、
  // DOM の value を直接書き換えて input イベントを投げただけでは onChange が発火しない。
  // ネイティブの setter 経由で書き込むことで、React 管理下でも変更を検知させる。
  function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    const proto =
      el instanceof HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
    act(() => {
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  test('新規作成は既定で saved query 参照モードになる', () => {
    act(() =>
      root.render(
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
        />,
      ),
    );
    expect(radio('Saved query').getAttribute('aria-checked')).toBe('true');
    // saved query モードでは SQL テキストエリアが表示されない。
    expect(container.querySelector('[aria-label="SQL statement"]')).toBeNull();
    expect(container.querySelector('[aria-label="Saved query"]')).not.toBeNull();
  });

  test('saved query モードで作成すると savedQueryId のみを送る', () => {
    const onCreate = vi.fn();
    act(() =>
      root.render(
        <ScheduleFormModal
          open
          schedule={null}
          context={{}}
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
    const nameInput = container.querySelector('[aria-label="Schedule name"]') as HTMLInputElement;
    typeInto(nameInput, 'My schedule');
    clickSave('Create schedule');

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'My schedule', savedQueryId: 'saved-1' }),
    );
    const body = onCreate.mock.calls[0]![0];
    expect(body.statement).toBeUndefined();
    // saved query の datasourceId が prefill されている。
    expect(body.datasourceId).toBe('trino-default');
  });

  test('Direct SQL へ切り替えると statement のみを送る', () => {
    const onCreate = vi.fn();
    act(() =>
      root.render(
        <ScheduleFormModal
          open
          schedule={null}
          context={{}}
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
    act(() => radio('Direct SQL').click());
    expect(container.querySelector('[aria-label="SQL statement"]')).not.toBeNull();

    const nameInput = container.querySelector('[aria-label="Schedule name"]') as HTMLInputElement;
    const statementInput = container.querySelector(
      '[aria-label="SQL statement"]',
    ) as HTMLTextAreaElement;
    typeInto(nameInput, 'Direct schedule');
    typeInto(statementInput, 'SELECT count(*) FROM tpch.tiny.nation');
    clickSave('Create schedule');

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Direct schedule',
        statement: 'SELECT count(*) FROM tpch.tiny.nation',
      }),
    );
    const body = onCreate.mock.calls[0]![0];
    expect(body.savedQueryId).toBeUndefined();
  });

  test('既存スケジュール（直書き statement）の編集は Direct SQL モードで開く', () => {
    act(() =>
      root.render(
        <ScheduleFormModal
          open
          schedule={schedule({ statement: 'SELECT 1', savedQueryId: null })}
          context={{}}
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
    expect(radio('Direct SQL').getAttribute('aria-checked')).toBe('true');
    expect(
      (container.querySelector('[aria-label="SQL statement"]') as HTMLTextAreaElement).value,
    ).toBe('SELECT 1');
  });

  test('既存スケジュール（saved query 参照）の編集は Saved query モードで開く', () => {
    act(() =>
      root.render(
        <ScheduleFormModal
          open
          schedule={schedule({ statement: null, savedQueryId: 'saved-1' })}
          context={{}}
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
    expect(radio('Saved query').getAttribute('aria-checked')).toBe('true');
    const select = container.querySelector('[aria-label="Saved query"]') as HTMLSelectElement;
    expect(select.value).toBe('saved-1');
  });

  // 指摘1: saved query 一覧の取得が完了する前にモーダルを開くと、初回マウント時点では
  // savedQueries が空配列になる。一覧が後から届いたときに選択が復旧しない回帰を防ぐ。
  test('saved query 一覧が非同期に届いた場合、未選択のまま先頭候補へ復旧する', () => {
    act(() =>
      root.render(
        <ScheduleFormModal
          open
          schedule={null}
          context={{}}
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
          context={{}}
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
    // 先頭候補の datasourceId/catalog/schema も 3 点セットで prefill されている。
    expect((container.querySelector('[aria-label="Catalog"]') as HTMLInputElement).value).toBe(
      'tpch',
    );
    expect((container.querySelector('[aria-label="Schema"]') as HTMLInputElement).value).toBe(
      'tiny',
    );
  });

  // 指摘2: saved query を選び直すと、その保存済みクエリの datasourceId/catalog/schema を
  // 3 点セットで prefill する（3 つがバラバラの組み合わせのまま送信されるのを防ぐ）。
  test('saved query を選び直すと datasourceId/catalog/schema を 3 点セットで prefill する', () => {
    act(() =>
      root.render(
        <ScheduleFormModal
          open
          schedule={null}
          context={{ catalog: 'notebook_catalog', schema: 'notebook_schema' }}
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
    // 初期選択（先頭の saved-1）の時点では notebook のコンテキストではなく saved query の値。
    expect((container.querySelector('[aria-label="Catalog"]') as HTMLInputElement).value).toBe(
      'tpch',
    );

    const select = container.querySelector('[aria-label="Saved query"]') as HTMLSelectElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype,
        'value',
      )!.set!;
      setter.call(select, 'saved-2');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect((container.querySelector('[aria-label="Catalog"]') as HTMLInputElement).value).toBe(
      'sales',
    );
    expect((container.querySelector('[aria-label="Schema"]') as HTMLInputElement).value).toBe(
      'rollup',
    );
    const dsTrigger = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'MySQL analytics',
    );
    expect(dsTrigger).not.toBeUndefined();
  });

  // 再レビュー指摘1: Direct SQL モードのまま saved query 一覧が届いた場合、一覧到着時点
  // では復旧されない（queryMode !== 'saved' のため）。その後 Saved query モードへ
  // 切り替えた時点で復旧されることを確認する（切替ハンドラー側の復旧処理の回帰テスト）。
  test('直書き編集を一覧取得前に開く→一覧到着→saved へ切替、の順で選択が復旧する', () => {
    act(() =>
      root.render(
        <ScheduleFormModal
          open
          schedule={schedule({ statement: 'SELECT 1', savedQueryId: null })}
          context={{}}
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
    expect(radio('Direct SQL').getAttribute('aria-checked')).toBe('true');

    // savedQueries が非同期に届く。schedule は direct モードのままなので、この時点では
    // まだ何も選択されない（select 自体も描画されない）。
    act(() =>
      root.render(
        <ScheduleFormModal
          open
          schedule={schedule({ statement: 'SELECT 1', savedQueryId: null })}
          context={{}}
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
    expect(container.querySelector('[aria-label="Saved query"]')).toBeNull();

    // ここで Saved query モードへ切り替える。切替時点で先頭候補へ復旧するはず。
    act(() => radio('Saved query').click());
    const select = container.querySelector('[aria-label="Saved query"]') as HTMLSelectElement;
    expect(select).not.toBeNull();
    expect(select.value).toBe('saved-1');
    expect((container.querySelector('[aria-label="Catalog"]') as HTMLInputElement).value).toBe(
      'tpch',
    );
  });

  // 再レビュー指摘2: datasourceId 未設定の saved query へ選択変更すると、前に選んでいた
  // query の datasourceId が取り残されてはいけない。意味上の既定データソース
  // （defaultDatasourceId、なければ datasources[0]）へ必ず更新されることを確認する。
  test('datasourceId 未設定の saved query へ選び直すと既定データソースへリセットされる', () => {
    const savedQueriesWithoutDatasource: SavedQuery[] = [
      ...savedQueries,
      {
        id: 'saved-3',
        name: 'No datasource set',
        description: '',
        statement: 'SELECT 1',
        catalog: 'legacy_catalog',
        schema: 'legacy_schema',
        // datasourceId 未設定（古い saved query を想定）。
        isFavorite: false,
        createdAt: timestamp,
        updatedAt: timestamp,
        myPermission: 'owner',
      },
    ];
    act(() =>
      root.render(
        <ScheduleFormModal
          open
          schedule={null}
          context={{}}
          datasources={datasources}
          savedQueries={savedQueriesWithoutDatasource}
          submitting={false}
          serverError={null}
          onClose={vi.fn()}
          onCreate={vi.fn()}
          onUpdate={vi.fn()}
        />,
      ),
    );

    const select = container.querySelector('[aria-label="Saved query"]') as HTMLSelectElement;
    const setSelectValue = (value: string) => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype,
        'value',
      )!.set!;
      act(() => {
        setter.call(select, value);
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
    };

    // まず mysql-analytics を選び、datasourceId がそちらへ prefill されることを確認する。
    setSelectValue('saved-2');
    expect(
      [...container.querySelectorAll('button')].some((b) => b.textContent === 'MySQL analytics'),
    ).toBe(true);

    // 続けて datasourceId 未設定の saved-3 へ選び直すと、前の mysql-analytics が
    // 残らず、既定データソース（datasources[0] の Trino）へリセットされる。
    setSelectValue('saved-3');
    expect(
      [...container.querySelectorAll('button')].some((b) => b.textContent === 'MySQL analytics'),
    ).toBe(false);
    expect(
      [...container.querySelectorAll('button')].some((b) => b.textContent === 'Trino (default)'),
    ).toBe(true);
  });

  // 指摘3: server は cron を server local timezone で評価するため、読み下しに
  // その基準を常時明記する。未取得の間のフォールバック表示も確認する。
  test('cron の読み下しに server timezone を明記する（未取得なら「サーバー時刻基準」）', () => {
    act(() =>
      root.render(
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
        />,
      ),
    );
    expect(container.textContent).toContain('サーバー時刻基準');

    vi.mocked(useServerTimeZone).mockReturnValue('Asia/Tokyo');
    act(() =>
      root.render(
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
        />,
      ),
    );
    expect(container.textContent).toContain('サーバー時刻: Asia/Tokyo');
  });
});
