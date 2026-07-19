import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { notebookSchema, type Notebook } from '@hubble/contracts';
import { ApiClientError } from '../api/client';
import { hasAttemptedRestore, markRestoreAttempted } from '../execution';
import {
  useNotebookStore,
  blankNotebook,
  moveItem,
  recomputeVariables,
  persistNewNotebook,
  persistSavedNotebook,
  AUTOSAVE_DEBOUNCE_MS,
  __setPersistence,
  readDraftRestoreResult,
  readWorkspaceSnapshot,
  type NotebookPersistence,
} from './notebookStore';

function reset(): void {
  useNotebookStore.setState({ open: {}, openIds: [], activeId: null });
}

function makeNotebook(over: Partial<Notebook> = {}): Notebook {
  const now = '2026-06-12T00:00:00.000Z';
  return {
    id: 'nb-1',
    name: 'Test',
    description: '',
    cells: [{ id: 'c1', kind: 'sql', source: 'SELECT 1' }],
    variables: [],
    context: { catalog: 'tpch', schema: 'sf1' },
    createdAt: now,
    updatedAt: now,
    myPermission: 'owner',
    ...over,
    revision: over.revision ?? 1,
  };
}

beforeEach(() => {
  reset();
  __setPersistence(null);
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('open / close / active', () => {
  test('openNotebook adds a tab and activates it', () => {
    useNotebookStore.getState().openNotebook(makeNotebook());
    const s = useNotebookStore.getState();
    expect(s.openIds).toEqual(['nb-1']);
    expect(s.activeId).toBe('nb-1');
    expect(s.open['nb-1']?.dirty).toBe(false);
  });

  test('closeNotebook removes the tab and re-points active', () => {
    const st = useNotebookStore.getState();
    st.openNotebook(makeNotebook({ id: 'a' }));
    st.openNotebook(makeNotebook({ id: 'b' }));
    useNotebookStore.getState().closeNotebook('b');
    const s = useNotebookStore.getState();
    expect(s.openIds).toEqual(['a']);
    expect(s.activeId).toBe('a');
  });

  // 指摘2: 結果自動復元（restoreCell）の「試行済み」記録は execution レイヤーの
  // モジュールレベル集合で管理する（SqlCell の再マウントを跨いで保持するため）。
  // notebook を閉じたら、その notebook のセル分の記録も一緒に寿命を終える必要が
  // ある（さもないと二度と開かれない notebook のセルの分だけ無制限に増え続ける）。
  test('closeNotebook はそのnotebookのセルに紐づく結果自動復元の試行済み記録を消す', () => {
    const st = useNotebookStore.getState();
    st.openNotebook(makeNotebook({ id: 'a', cells: [{ id: 'ca', kind: 'sql', source: 'X' }] }));
    st.openNotebook(makeNotebook({ id: 'b', cells: [{ id: 'cb', kind: 'sql', source: 'Y' }] }));
    markRestoreAttempted('ca', 'qa');
    markRestoreAttempted('cb', 'qb');

    useNotebookStore.getState().closeNotebook('a');

    // 閉じた notebook（a）のセルの記録だけが消える。
    expect(hasAttemptedRestore('ca', 'qa')).toBe(false);
    // 開いたままの notebook（b）のセルの記録は残る。
    expect(hasAttemptedRestore('cb', 'qb')).toBe(true);
  });

  test('createBlankNotebook opens a draft with one empty SQL cell', () => {
    const id = useNotebookStore.getState().createBlankNotebook();
    const entry = useNotebookStore.getState().open[id];
    expect(entry?.draft).toBe(true);
    expect(entry?.notebook.cells).toHaveLength(1);
    expect(entry?.notebook.cells[0]?.kind).toBe('sql');
    expect(localStorage.getItem(`hubble-draft:${id}`)).not.toBeNull();
  });
});

describe('cell CRUD + move', () => {
  test('addCell end / above / below', () => {
    const st = useNotebookStore.getState();
    st.openNotebook(makeNotebook());
    const endId = useNotebookStore.getState().addCell('nb-1', 'markdown', 'end');
    let cells = useNotebookStore.getState().open['nb-1']!.notebook.cells;
    expect(cells.map((c) => c.id)).toEqual(['c1', endId]);

    const aboveId = useNotebookStore
      .getState()
      .addCell('nb-1', 'sql', { relativeTo: 'c1', where: 'above' });
    cells = useNotebookStore.getState().open['nb-1']!.notebook.cells;
    expect(cells[0]?.id).toBe(aboveId);

    const belowId = useNotebookStore
      .getState()
      .addCell('nb-1', 'sql', { relativeTo: 'c1', where: 'below' });
    cells = useNotebookStore.getState().open['nb-1']!.notebook.cells;
    const c1Index = cells.findIndex((c) => c.id === 'c1');
    expect(cells[c1Index + 1]?.id).toBe(belowId);
  });

  test('removeCell drops the cell and marks dirty', () => {
    useNotebookStore.getState().openNotebook(makeNotebook());
    useNotebookStore.getState().removeCell('nb-1', 'c1');
    const entry = useNotebookStore.getState().open['nb-1']!;
    expect(entry.notebook.cells).toHaveLength(0);
    expect(entry.dirty).toBe(true);
  });

  // 指摘1（P1）: removeCell はセルを配列から除くだけで、closeNotebook が
  // 列挙するのは残存セルのみのため、削除済みセルの結果自動復元「試行済み」
  // 記録が回収されずに残ってしまっていた。removeCell 自身が対象セル分を
  // 消去することを確認する。
  test('removeCell は削除したセルの結果自動復元の試行済み記録も消す', () => {
    useNotebookStore.getState().openNotebook(
      makeNotebook({
        cells: [
          { id: 'c1', kind: 'sql', source: 'SELECT 1' },
          { id: 'c2', kind: 'sql', source: 'SELECT 2' },
        ],
      }),
    );
    markRestoreAttempted('c1', 'q1');
    markRestoreAttempted('c2', 'q2');

    useNotebookStore.getState().removeCell('nb-1', 'c1');

    expect(hasAttemptedRestore('c1', 'q1')).toBe(false);
    // 削除していない c2 の記録は残る。
    expect(hasAttemptedRestore('c2', 'q2')).toBe(true);
  });

  // 指摘1（P1）: replaceNotebook で notebook を丸ごと差し替えたとき、新しい
  // cells 集合に存在しない旧セル（サーバー側で削除された等）の分も、結果自動
  // 復元の試行済み記録が回収されていなかった。旧セル集合と新セル集合の差分
  // （消えるセル）だけを消去することを確認する。
  test('replaceNotebook は新しい cells 集合に存在しない旧セルの試行済み記録を消す', () => {
    const st = useNotebookStore.getState();
    st.openNotebook(
      makeNotebook({
        cells: [
          { id: 'c1', kind: 'sql', source: 'SELECT 1' },
          { id: 'c2', kind: 'sql', source: 'SELECT 2' },
        ],
      }),
    );
    markRestoreAttempted('c1', 'q1');
    markRestoreAttempted('c2', 'q2');

    // サーバーから返ってきた最新版では c1 が消え、c3 が新規追加されている。
    useNotebookStore.getState().replaceNotebook(
      makeNotebook({
        cells: [
          { id: 'c2', kind: 'sql', source: 'SELECT 2' },
          { id: 'c3', kind: 'sql', source: 'SELECT 3' },
        ],
      }),
    );

    // 新集合に存在しない c1 の記録は消える。
    expect(hasAttemptedRestore('c1', 'q1')).toBe(false);
    // 新集合にも残る c2 の記録はそのまま。
    expect(hasAttemptedRestore('c2', 'q2')).toBe(true);
  });

  test('moveCell reorders', () => {
    useNotebookStore.getState().openNotebook(
      makeNotebook({
        cells: [
          { id: 'a', kind: 'sql', source: '' },
          { id: 'b', kind: 'sql', source: '' },
          { id: 'c', kind: 'sql', source: '' },
        ],
      }),
    );
    useNotebookStore.getState().moveCell('nb-1', 0, 2);
    const cells = useNotebookStore.getState().open['nb-1']!.notebook.cells;
    expect(cells.map((c) => c.id)).toEqual(['b', 'c', 'a']);
  });

  test('setCellName clears name when blank', () => {
    useNotebookStore.getState().openNotebook(makeNotebook());
    useNotebookStore.getState().setCellName('nb-1', 'c1', 'My cell');
    expect(useNotebookStore.getState().open['nb-1']!.notebook.cells[0]?.name).toBe('My cell');
    useNotebookStore.getState().setCellName('nb-1', 'c1', '  ');
    expect(useNotebookStore.getState().open['nb-1']!.notebook.cells[0]?.name).toBeUndefined();
  });

  test('toggleCellCollapsed flips the flag', () => {
    useNotebookStore.getState().openNotebook(makeNotebook());
    useNotebookStore.getState().toggleCellCollapsed('nb-1', 'c1');
    expect(useNotebookStore.getState().open['nb-1']!.notebook.cells[0]?.collapsed).toBe(true);
  });
});

describe('moveItem (pure helper)', () => {
  test('moves within bounds; ignores out-of-range', () => {
    expect(moveItem([1, 2, 3], 0, 2)).toEqual([2, 3, 1]);
    expect(moveItem([1, 2, 3], 2, 0)).toEqual([3, 1, 2]);
    expect(moveItem([1, 2, 3], 5, 0)).toEqual([1, 2, 3]);
  });
});

describe('variables recompute', () => {
  test('editing SQL source refreshes notebook.variables', () => {
    useNotebookStore.getState().openNotebook(makeNotebook());
    useNotebookStore.getState().setCellSource('nb-1', 'c1', 'SELECT * FROM t LIMIT ${n=10}');
    const vars = useNotebookStore.getState().open['nb-1']!.notebook.variables;
    expect(vars.map((v) => v.name)).toEqual(['n']);
    expect(vars[0]?.value).toBe('10');
    expect(vars[0]?.meta.type).toBe('number');
  });

  test('setVariableValue updates value without altering cells', () => {
    useNotebookStore
      .getState()
      .openNotebook(makeNotebook({ cells: [{ id: 'c1', kind: 'sql', source: 'LIMIT ${n=10}' }] }));
    // recompute happens on open? No — open does not recompute. Trigger via edit.
    useNotebookStore.getState().setCellSource('nb-1', 'c1', 'LIMIT ${n=10}');
    useNotebookStore.getState().setVariableValue('nb-1', 'n', '42');
    const nb = useNotebookStore.getState().open['nb-1']!.notebook;
    expect(nb.variables.find((v) => v.name === 'n')?.value).toBe('42');
  });

  test('recomputeVariables is a pure function', () => {
    const nb = makeNotebook({ cells: [{ id: 'c1', kind: 'sql', source: "WHERE s='${s=O,F}'" }] });
    const vars = recomputeVariables(nb);
    expect(vars[0]?.meta.type).toBe('select');
    expect(vars[0]?.meta.options).toHaveLength(2);
  });
});

describe('serialization round-trip', () => {
  test('a blank notebook validates against the contract schema', () => {
    const nb = blankNotebook({ catalog: 'tpch', schema: 'sf1' });
    expect(notebookSchema.safeParse(nb).success).toBe(true);
  });

  test('an edited open notebook round-trips through the schema', () => {
    useNotebookStore.getState().openNotebook(makeNotebook());
    const st = useNotebookStore.getState();
    st.addCell('nb-1', 'markdown', 'end');
    st.setCellSource('nb-1', 'c1', 'SELECT * FROM t WHERE id = ${id} LIMIT ${n=5}');
    st.renameNotebook('nb-1', 'Renamed');
    const nb = useNotebookStore.getState().open['nb-1']!.notebook;
    const parsed = notebookSchema.safeParse(JSON.parse(JSON.stringify(nb)));
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.name).toBe('Renamed');
    expect(parsed.success && parsed.data.variables.map((v) => v.name)).toEqual(['id', 'n']);
  });
});

describe('autosave debounce (fake timers)', () => {
  test('保存済みnotebookの編集をPUT前にlocal journalへ同期保存する', () => {
    vi.useFakeTimers();
    __setPersistence({
      create: vi.fn(async (nb) => nb),
      update: vi.fn(async (_id, nb) => ({ ...nb, revision: nb.revision + 1 })),
    });
    useNotebookStore.getState().openNotebook(makeNotebook(), { draft: false });

    useNotebookStore.getState().setCellSource('nb-1', 'c1', 'SELECT journal');

    const journal = JSON.parse(localStorage.getItem('hubble-notebook-journal:nb-1')!);
    expect(journal).toMatchObject({
      version: 1,
      id: 'nb-1',
      baseRevision: 1,
      editGeneration: 1,
      notebook: { id: 'nb-1', revision: 1 },
    });
    expect(journal.notebook.cells[0].source).toBe('SELECT journal');
    expect(useNotebookStore.getState().open['nb-1']).toMatchObject({
      durableGeneration: 1,
      localPersistenceError: false,
    });
  });

  test('reload時に同じbase revisionのlocal journalを未保存編集として復元する', () => {
    vi.useFakeTimers();
    const local = makeNotebook({
      cells: [{ id: 'c1', kind: 'sql', source: 'SELECT recovered' }],
    });
    localStorage.setItem(
      'hubble-notebook-journal:nb-1',
      JSON.stringify({
        version: 1,
        id: 'nb-1',
        baseRevision: 1,
        editGeneration: 4,
        notebook: local,
      }),
    );

    useNotebookStore.getState().openNotebook(makeNotebook(), { draft: false });

    expect(useNotebookStore.getState().open['nb-1']).toMatchObject({
      notebook: { cells: [{ source: 'SELECT recovered' }] },
      dirty: true,
      conflict: false,
      editGeneration: 4,
      durableGeneration: 4,
    });
  });

  test('server revisionが進んだlocal journalは内容を保全して競合扱いにする', () => {
    const local = makeNotebook({
      cells: [{ id: 'c1', kind: 'sql', source: 'SELECT local' }],
    });
    localStorage.setItem(
      'hubble-notebook-journal:nb-1',
      JSON.stringify({
        version: 1,
        id: 'nb-1',
        baseRevision: 1,
        editGeneration: 2,
        notebook: local,
      }),
    );

    useNotebookStore.getState().openNotebook(makeNotebook({ revision: 2 }), { draft: false });

    expect(useNotebookStore.getState().open['nb-1']).toMatchObject({
      notebook: { cells: [{ source: 'SELECT local' }] },
      dirty: true,
      conflict: true,
    });
    expect(localStorage.getItem('hubble-notebook-journal:nb-1')).not.toBeNull();
  });

  test('a saved notebook PUTs once after the debounce window', async () => {
    vi.useFakeTimers();
    const update = vi.fn(async (_id: string, nb: Notebook) => nb);
    const persistence: NotebookPersistence = {
      create: vi.fn(async (nb) => nb),
      update,
    };
    __setPersistence(persistence);

    // A *saved* notebook (draft: false).
    useNotebookStore.getState().openNotebook(makeNotebook(), { draft: false });
    useNotebookStore.getState().setCellSource('nb-1', 'c1', 'SELECT 2');

    // Before the window: no PUT yet.
    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS - 1);
    expect(update).not.toHaveBeenCalled();

    // Rapid second edit resets the debounce — still only one PUT eventually.
    useNotebookStore.getState().setCellSource('nb-1', 'c1', 'SELECT 3');
    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS);
    await vi.runAllTimersAsync();

    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]?.[1].cells[0]?.source).toBe('SELECT 3');
    expect(update.mock.calls[0]?.[1].revision).toBe(1);
    expect(useNotebookStore.getState().open['nb-1']?.dirty).toBe(false);
  });

  test('an edit made during autosave survives the older response', async () => {
    vi.useFakeTimers();
    let resolveUpdate!: (notebook: Notebook) => void;
    const update = vi.fn(
      (_id: string, _nb: Notebook) =>
        new Promise<Notebook>((resolve) => {
          void _id;
          void _nb;
          resolveUpdate = resolve;
        }),
    );
    __setPersistence({ create: vi.fn(async (nb) => nb), update });
    useNotebookStore.getState().openNotebook(makeNotebook(), { draft: false });
    useNotebookStore.getState().setCellSource('nb-1', 'c1', 'SELECT 2');

    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(update).toHaveBeenCalledTimes(1);
    useNotebookStore.getState().setCellSource('nb-1', 'c1', 'SELECT 3');
    resolveUpdate(
      makeNotebook({
        revision: 2,
        cells: [{ id: 'c1', kind: 'sql', source: 'SELECT 2' }],
      }),
    );
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(2));

    const current = useNotebookStore.getState().open['nb-1']!;
    expect(current.notebook.cells[0]?.source).toBe('SELECT 3');
    expect(current.notebook.revision).toBe(2);
    expect(current.dirty).toBe(true);
    expect(current.saving).toBe(true);

    expect(update.mock.calls[1]?.[1].revision).toBe(2);
    expect(JSON.parse(localStorage.getItem('hubble-notebook-journal:nb-1')!)).toMatchObject({
      baseRevision: 2,
      editGeneration: 2,
      notebook: { cells: [{ source: 'SELECT 3' }] },
    });
    resolveUpdate(
      makeNotebook({
        revision: 3,
        cells: [{ id: 'c1', kind: 'sql', source: 'SELECT 3' }],
      }),
    );
    await vi.waitFor(() => expect(useNotebookStore.getState().open['nb-1']?.saving).toBe(false));
    expect(useNotebookStore.getState().open['nb-1']?.dirty).toBe(false);
    expect(localStorage.getItem('hubble-notebook-journal:nb-1')).toBeNull();
  });

  test('保存中の明示Saveを同じsingle-flightへ合流させる', async () => {
    vi.useFakeTimers();
    let active = 0;
    let maxActive = 0;
    const resolvers: ((notebook: Notebook) => void)[] = [];
    const update = vi.fn(
      (_id: string, notebook: Notebook) =>
        new Promise<Notebook>((resolve) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          resolvers.push((saved) => {
            active -= 1;
            resolve(saved);
          });
          void notebook;
        }),
    );
    __setPersistence({ create: vi.fn(async (nb) => nb), update });
    useNotebookStore.getState().openNotebook(makeNotebook(), { draft: false });
    useNotebookStore.getState().setCellSource('nb-1', 'c1', 'SELECT 2');

    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    const explicit = persistSavedNotebook('nb-1');
    expect(update).toHaveBeenCalledTimes(1);
    resolvers[0]!(makeNotebook({ revision: 2 }));

    await expect(explicit).resolves.toMatchObject({ revision: 2 });
    expect(update).toHaveBeenCalledTimes(1);
    expect(maxActive).toBe(1);
    expect(useNotebookStore.getState().open['nb-1']?.conflict).toBe(false);
  });

  test('閉じる前のPUT応答が同じIDで開き直したnotebookを上書きしない', async () => {
    vi.useFakeTimers();
    let resolveOldSave!: (notebook: Notebook) => void;
    const update = vi.fn(
      () =>
        new Promise<Notebook>((resolve) => {
          resolveOldSave = resolve;
        }),
    );
    __setPersistence({ create: vi.fn(async (nb) => nb), update });
    useNotebookStore.getState().openNotebook(makeNotebook(), { draft: false });
    useNotebookStore.getState().setCellSource('nb-1', 'c1', 'SELECT before-close');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);

    useNotebookStore.getState().closeNotebook('nb-1');
    useNotebookStore.getState().openNotebook(makeNotebook(), { draft: false });
    useNotebookStore.getState().setCellSource('nb-1', 'c1', 'SELECT after-reopen');
    resolveOldSave(
      makeNotebook({
        revision: 2,
        cells: [{ id: 'c1', kind: 'sql', source: 'SELECT before-close' }],
      }),
    );
    await Promise.resolve();

    expect(useNotebookStore.getState().open['nb-1']).toMatchObject({
      notebook: { revision: 2, cells: [{ source: 'SELECT after-reopen' }] },
      dirty: true,
      saving: false,
      conflict: false,
    });
  });

  test('閉じる前のPUT完了まで開き直し後のPUTを待ち、新revisionへrebaseする', async () => {
    vi.useFakeTimers();
    let resolveOldSave!: (notebook: Notebook) => void;
    const update = vi
      .fn<(_id: string, notebook: Notebook) => Promise<Notebook>>()
      .mockImplementationOnce(
        () =>
          new Promise<Notebook>((resolve) => {
            resolveOldSave = resolve;
          }),
      )
      .mockImplementationOnce(async (_id, notebook) => ({
        ...notebook,
        revision: notebook.revision + 1,
      }));
    __setPersistence({ create: vi.fn(async (nb) => nb), update });
    useNotebookStore.getState().openNotebook(makeNotebook(), { draft: false });
    useNotebookStore.getState().setCellSource('nb-1', 'c1', 'SELECT before-close');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);

    useNotebookStore.getState().closeNotebook('nb-1');
    useNotebookStore.getState().openNotebook(makeNotebook(), { draft: false });
    useNotebookStore.getState().setCellSource('nb-1', 'c1', 'SELECT after-reopen');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(update).toHaveBeenCalledOnce();

    resolveOldSave(
      makeNotebook({
        revision: 2,
        cells: [{ id: 'c1', kind: 'sql', source: 'SELECT before-close' }],
      }),
    );
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(2));

    expect(update.mock.calls[1]?.[1]).toMatchObject({
      revision: 2,
      cells: [{ source: 'SELECT after-reopen' }],
    });
    await vi.waitFor(() =>
      expect(useNotebookStore.getState().open['nb-1']).toMatchObject({
        notebook: { revision: 3, cells: [{ source: 'SELECT after-reopen' }] },
        dirty: false,
        saving: false,
        conflict: false,
      }),
    );
  });

  test('古い世代の一時失敗後に最新世代だけを直列保存する', async () => {
    vi.useFakeTimers();
    let rejectFirst!: (error: Error) => void;
    let resolveSecond!: (notebook: Notebook) => void;
    const update = vi
      .fn<(_id: string, notebook: Notebook) => Promise<Notebook>>()
      .mockImplementationOnce(
        () =>
          new Promise<Notebook>((_resolve, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<Notebook>((resolve) => {
            resolveSecond = resolve;
          }),
      );
    __setPersistence({ create: vi.fn(async (nb) => nb), update });
    useNotebookStore.getState().openNotebook(makeNotebook(), { draft: false });
    useNotebookStore.getState().setCellSource('nb-1', 'c1', 'SELECT old');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    useNotebookStore.getState().setCellSource('nb-1', 'c1', 'SELECT latest');
    const explicit = persistSavedNotebook('nb-1');

    rejectFirst(new TypeError('offline'));
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(update.mock.calls[1]?.[1].cells[0]?.source).toBe('SELECT latest');
    resolveSecond(
      makeNotebook({
        revision: 2,
        cells: [{ id: 'c1', kind: 'sql', source: 'SELECT latest' }],
      }),
    );

    await expect(explicit).resolves.toMatchObject({ revision: 2 });
    expect(useNotebookStore.getState().open['nb-1']).toMatchObject({
      dirty: false,
      saving: false,
      conflict: false,
    });
    expect(localStorage.getItem('hubble-notebook-journal:nb-1')).toBeNull();
  });

  test('local journal書き込み失敗を表示状態に反映し、次世代成功で解除する', () => {
    const originalSetItem = Storage.prototype.setItem;
    let failJournal = true;
    const guarded = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key,
      value,
    ) {
      if (failJournal && key === 'hubble-notebook-journal:nb-1') {
        throw new DOMException('quota', 'QuotaExceededError');
      }
      return originalSetItem.call(this, key, value);
    });
    useNotebookStore.getState().openNotebook(makeNotebook(), { draft: false });

    useNotebookStore.getState().setCellSource('nb-1', 'c1', 'SELECT failed');
    expect(useNotebookStore.getState().open['nb-1']).toMatchObject({
      durableGeneration: 0,
      localPersistenceError: true,
    });

    failJournal = false;
    useNotebookStore.getState().setCellSource('nb-1', 'c1', 'SELECT durable');
    expect(useNotebookStore.getState().open['nb-1']).toMatchObject({
      durableGeneration: 2,
      localPersistenceError: false,
    });
    guarded.mockRestore();
  });

  test('PUT成功時は保存世代より古いjournalを削除する', async () => {
    vi.useFakeTimers();
    const originalSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (
        key === 'hubble-notebook-journal:nb-1' &&
        (JSON.parse(value) as { editGeneration?: number }).editGeneration === 2
      ) {
        throw new DOMException('quota', 'QuotaExceededError');
      }
      return originalSetItem.call(this, key, value);
    });
    const update = vi.fn(async (_id: string, notebook: Notebook) => ({
      ...notebook,
      revision: notebook.revision + 1,
    }));
    __setPersistence({ create: vi.fn(async (nb) => nb), update });
    useNotebookStore.getState().openNotebook(makeNotebook(), { draft: false });

    useNotebookStore.getState().setCellSource('nb-1', 'c1', 'SELECT generation-1');
    useNotebookStore.getState().setCellSource('nb-1', 'c1', 'SELECT generation-2');
    expect(localStorage.getItem('hubble-notebook-journal:nb-1')).toContain('generation-1');
    expect(useNotebookStore.getState().open['nb-1']?.localPersistenceError).toBe(true);

    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);

    expect(update).toHaveBeenCalledOnce();
    expect(localStorage.getItem('hubble-notebook-journal:nb-1')).toBeNull();
    expect(useNotebookStore.getState().open['nb-1']).toMatchObject({
      dirty: false,
      localPersistenceError: false,
    });
  });

  test('a revision conflict preserves local edits and stops autosave', async () => {
    vi.useFakeTimers();
    const update = vi.fn(async () => {
      throw new ApiClientError(409, {
        code: 'NOTEBOOK_REVISION_CONFLICT',
        message: 'conflict',
      });
    });
    __setPersistence({ create: vi.fn(async (nb) => nb), update });
    useNotebookStore.getState().openNotebook(makeNotebook(), { draft: false });
    useNotebookStore.getState().setCellSource('nb-1', 'c1', 'SELECT local');

    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    const conflicted = useNotebookStore.getState().open['nb-1']!;
    expect(conflicted.notebook.cells[0]?.source).toBe('SELECT local');
    expect(conflicted.conflict).toBe(true);
    expect(conflicted.dirty).toBe(true);
    expect(conflicted.saving).toBe(false);

    useNotebookStore.getState().setCellSource('nb-1', 'c1', 'SELECT still-local');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 2);
    expect(update).toHaveBeenCalledTimes(1);
  });

  test('a draft notebook is NOT autosaved (kept in localStorage instead)', async () => {
    vi.useFakeTimers();
    const update = vi.fn(async (_id: string, nb: Notebook) => nb);
    __setPersistence({ create: vi.fn(async (nb) => nb), update });

    const id = useNotebookStore.getState().createBlankNotebook();
    useNotebookStore
      .getState()
      .setCellSource(id, useNotebookStore.getState().open[id]!.notebook.cells[0]!.id, 'SELECT 9');
    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS * 2);
    await vi.runAllTimersAsync();

    expect(update).not.toHaveBeenCalled();
    expect(localStorage.getItem(`hubble-draft:${id}`)).toContain('SELECT 9');
  });

  test('draft書き込み失敗も状態へ反映し、後続世代の成功で解除する', () => {
    const originalSetItem = Storage.prototype.setItem;
    let blockedId: string | null = null;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (blockedId && key === `hubble-draft:${blockedId}`) {
        throw new DOMException('quota', 'QuotaExceededError');
      }
      return originalSetItem.call(this, key, value);
    });
    const id = useNotebookStore.getState().createBlankNotebook();
    blockedId = id;
    const cellId = useNotebookStore.getState().open[id]!.notebook.cells[0]!.id;

    useNotebookStore.getState().setCellSource(id, cellId, 'SELECT failed');
    expect(useNotebookStore.getState().open[id]).toMatchObject({
      durableGeneration: 0,
      localPersistenceError: true,
    });

    blockedId = null;
    useNotebookStore.getState().setCellSource(id, cellId, 'SELECT durable');
    expect(useNotebookStore.getState().open[id]).toMatchObject({
      durableGeneration: 2,
      localPersistenceError: false,
    });
  });

  test('workspace書き込み失敗時はdraft本文が書けても警告し、後続編集で再試行する', () => {
    const originalSetItem = Storage.prototype.setItem;
    let failWorkspace = true;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (failWorkspace && key === 'hubble-workspace') {
        throw new DOMException('quota', 'QuotaExceededError');
      }
      return originalSetItem.call(this, key, value);
    });

    const id = useNotebookStore.getState().createBlankNotebook();
    expect(localStorage.getItem(`hubble-draft:${id}`)).not.toBeNull();
    expect(useNotebookStore.getState().open[id]?.localPersistenceError).toBe(true);

    failWorkspace = false;
    const cellId = useNotebookStore.getState().open[id]!.notebook.cells[0]!.id;
    useNotebookStore.getState().setCellSource(id, cellId, 'SELECT durable workspace');

    expect(localStorage.getItem('hubble-workspace')).toContain(id);
    expect(useNotebookStore.getState().open[id]).toMatchObject({
      durableGeneration: 1,
      localPersistenceError: false,
    });
  });

  test('view-only shared notebook is NOT autosaved to the server', async () => {
    vi.useFakeTimers();
    const update = vi.fn(async (_id: string, nb: Notebook) => nb);
    __setPersistence({ create: vi.fn(async (nb) => nb), update });

    useNotebookStore
      .getState()
      .openNotebook(makeNotebook({ myPermission: 'view' }), { draft: false });
    useNotebookStore.getState().setCellSource('nb-1', 'c1', 'SELECT 2');
    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS * 2);
    await vi.runAllTimersAsync();

    expect(update).not.toHaveBeenCalled();
    expect(useNotebookStore.getState().open['nb-1']?.dirty).toBe(true);
  });
});

describe('explicit persistence', () => {
  test('persistNewNotebook POSTs a draft and re-keys it as saved', async () => {
    const create = vi.fn(async (nb: Notebook) => ({ ...nb, id: 'server-id' }));
    __setPersistence({ create, update: vi.fn(async (_i, nb) => nb) });

    const id = useNotebookStore.getState().createBlankNotebook();
    const saved = await persistNewNotebook(id, 'Saved name');

    expect(create).toHaveBeenCalledTimes(1);
    expect(saved?.id).toBe('server-id');
    const s = useNotebookStore.getState();
    expect(s.openIds).toEqual(['server-id']);
    expect(s.open['server-id']?.draft).toBe(false);
    expect(s.open['server-id']?.dirty).toBe(false);
    expect(s.open[id]).toBeUndefined();
    expect(localStorage.getItem(`hubble-draft:${id}`)).toBeNull();
  });

  test('POST中の編集後にworkspaceのre-keyが失敗した場合は旧draftを保持する', async () => {
    vi.useFakeTimers();
    let submitted!: Notebook;
    let resolveCreate!: (notebook: Notebook) => void;
    const create = vi.fn(
      (notebook: Notebook) =>
        new Promise<Notebook>((resolve) => {
          submitted = notebook;
          resolveCreate = resolve;
        }),
    );
    __setPersistence({ create, update: vi.fn(async (_i, nb) => nb) });
    const id = useNotebookStore.getState().createBlankNotebook();
    const cellId = useNotebookStore.getState().open[id]!.notebook.cells[0]!.id;

    const saving = persistNewNotebook(id, 'Saved name');
    useNotebookStore.getState().setCellSource(id, cellId, 'SELECT edited during POST');
    const oldDraftRaw = localStorage.getItem(`hubble-draft:${id}`);
    expect(oldDraftRaw).toContain('SELECT edited during POST');

    const originalSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key === 'hubble-workspace') {
        throw new DOMException('quota', 'QuotaExceededError');
      }
      return originalSetItem.call(this, key, value);
    });
    resolveCreate({ ...submitted, id: 'server-id', revision: 1 });
    await saving;

    expect(localStorage.getItem(`hubble-draft:${id}`)).toBe(oldDraftRaw);
    expect(localStorage.getItem('hubble-workspace')).toContain(id);
    expect(localStorage.getItem('hubble-workspace')).not.toContain('server-id');
    expect(localStorage.getItem('hubble-notebook-journal:server-id')).toContain(
      'SELECT edited during POST',
    );
    expect(useNotebookStore.getState().open['server-id']).toMatchObject({
      dirty: true,
      localPersistenceError: true,
      notebook: { cells: [{ source: 'SELECT edited during POST' }] },
    });
  });

  test('persistSavedNotebook PUTs immediately and clears dirty', async () => {
    const update = vi.fn(async (_id: string, nb: Notebook) => nb);
    __setPersistence({ create: vi.fn(async (nb) => nb), update });
    useNotebookStore.getState().openNotebook(makeNotebook(), { draft: false });
    useNotebookStore.getState().setCellSource('nb-1', 'c1', 'SELECT 5');
    const saved = await persistSavedNotebook('nb-1');
    expect(update).toHaveBeenCalledTimes(1);
    expect(saved?.cells[0]?.source).toBe('SELECT 5');
    expect(useNotebookStore.getState().open['nb-1']?.dirty).toBe(false);
  });

  test('persistSavedNotebook skips view-only notebooks', async () => {
    const update = vi.fn(async (_id: string, nb: Notebook) => nb);
    __setPersistence({ create: vi.fn(async (nb) => nb), update });
    useNotebookStore
      .getState()
      .openNotebook(makeNotebook({ myPermission: 'view' }), { draft: false });
    useNotebookStore.getState().setCellSource('nb-1', 'c1', 'SELECT 5');
    const saved = await persistSavedNotebook('nb-1');
    expect(update).not.toHaveBeenCalled();
    expect(saved).toBeNull();
  });
});

describe('workspace persistence', () => {
  test('open tabs + active are mirrored to localStorage', () => {
    useNotebookStore.getState().openNotebook(makeNotebook({ id: 'a' }));
    useNotebookStore.getState().openNotebook(makeNotebook({ id: 'b' }));
    const snap = JSON.parse(localStorage.getItem('hubble-workspace')!);
    expect(snap.version).toBe(1);
    expect(snap.openIds).toEqual(['a', 'b']);
    expect(snap.activeId).toBe('b');
  });

  test('versionなしworkspace snapshotを拒否して退避する', () => {
    localStorage.setItem(
      'hubble-workspace',
      JSON.stringify({ openIds: ['a'], activeId: 'a', draftIds: [] }),
    );
    expect(readWorkspaceSnapshot()).toBeNull();
    expect(localStorage.getItem('hubble-workspace-backup')).toBe(
      JSON.stringify({ openIds: ['a'], activeId: 'a', draftIds: [] }),
    );
  });

  test('構造が不正なworkspace snapshotを拒否する', () => {
    const raw = JSON.stringify({ version: 1, openIds: 'a', activeId: 'a', draftIds: [] });
    localStorage.setItem('hubble-workspace', raw);
    expect(readWorkspaceSnapshot()).toBeNull();
    expect(localStorage.getItem('hubble-workspace-backup')).toBe(raw);
  });

  test('workspace backupを直近の破損内容で更新する', () => {
    const first = '{"broken":1}';
    const second = '{"broken":2}';
    localStorage.setItem('hubble-workspace', first);
    expect(readWorkspaceSnapshot()).toBeNull();
    localStorage.setItem('hubble-workspace', second);
    expect(readWorkspaceSnapshot()).toBeNull();

    expect(localStorage.getItem('hubble-workspace-backup')).toBe(second);
  });

  test('valid draftを復元し、破損draftはrawを残してworkspaceから除く', () => {
    localStorage.setItem(
      'hubble-workspace',
      JSON.stringify({
        version: 1,
        openIds: ['good', 'bad'],
        activeId: 'good',
        draftIds: ['good', 'bad'],
      }),
    );
    localStorage.setItem('hubble-draft:good', JSON.stringify(makeNotebook({ id: 'good' })));
    localStorage.setItem('hubble-draft:bad', JSON.stringify({ id: 'bad', name: 'broken' }));

    const result = readDraftRestoreResult();
    expect(result).toEqual({
      drafts: [makeNotebook({ id: 'good' })],
      corruptIds: ['bad'],
      snapshot: {
        version: 1,
        openIds: ['good'],
        activeId: 'good',
        draftIds: ['good'],
      },
    });
    expect(localStorage.getItem('hubble-draft:bad')).toBe(
      JSON.stringify({ id: 'bad', name: 'broken' }),
    );
    expect(readWorkspaceSnapshot()?.draftIds).toEqual(['good']);
    expect(readDraftRestoreResult().corruptIds).toEqual([]);
  });

  test('rawが無いdraftを通知対象にせずworkspaceから除く', () => {
    localStorage.setItem(
      'hubble-workspace',
      JSON.stringify({
        version: 1,
        openIds: ['missing'],
        activeId: 'missing',
        draftIds: ['missing'],
      }),
    );

    const first = readDraftRestoreResult();
    const second = readDraftRestoreResult();

    expect(first.corruptIds).toEqual([]);
    expect(first.snapshot).toMatchObject({ openIds: [], activeId: null, draftIds: [] });
    expect(second.corruptIds).toEqual([]);
  });

  test('保存キーと内部IDが異なるdraftを破損としてrawのまま残す', () => {
    localStorage.setItem(
      'hubble-workspace',
      JSON.stringify({
        version: 1,
        openIds: ['key-id'],
        activeId: 'key-id',
        draftIds: ['key-id'],
      }),
    );
    const raw = JSON.stringify(makeNotebook({ id: 'internal-id' }));
    localStorage.setItem('hubble-draft:key-id', raw);

    const result = readDraftRestoreResult();

    expect(result.corruptIds).toEqual(['key-id']);
    expect(localStorage.getItem('hubble-draft:key-id')).toBe(raw);
    expect(readWorkspaceSnapshot()?.draftIds).toEqual([]);
  });

  test('参照されないdraft rawを新しい5件だけ残す', () => {
    const ids = Array.from({ length: 7 }, (_, index) => `orphan-${index}`);
    localStorage.setItem(
      'hubble-workspace',
      JSON.stringify({ version: 1, openIds: [], activeId: null, draftIds: [] }),
    );
    ids.forEach((id, index) =>
      localStorage.setItem(
        `hubble-draft:${id}`,
        JSON.stringify(
          makeNotebook({ id, updatedAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString() }),
        ),
      ),
    );

    readDraftRestoreResult();

    expect(localStorage.getItem('hubble-draft:orphan-0')).toBeNull();
    expect(localStorage.getItem('hubble-draft:orphan-1')).toBeNull();
    expect(ids.slice(2).every((id) => localStorage.getItem(`hubble-draft:${id}`) !== null)).toBe(
      true,
    );
  });

  test('workspace snapshotが無い場合は孤立判定できないため掃除しない', () => {
    localStorage.removeItem('hubble-workspace');
    const ids = Array.from({ length: 6 }, (_, index) => `orphan-${index}`);
    ids.forEach((id, index) =>
      localStorage.setItem(
        `hubble-draft:${id}`,
        JSON.stringify(
          makeNotebook({ id, updatedAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString() }),
        ),
      ),
    );

    expect(readDraftRestoreResult().snapshot).toBeNull();

    expect(ids.every((id) => localStorage.getItem(`hubble-draft:${id}`) !== null)).toBe(true);
  });

  test('破損workspaceのbackupが参照し得るdraftを掃除しない', () => {
    const ids = Array.from({ length: 7 }, (_, index) => `draft-${index}`);
    ids.forEach((id) => localStorage.setItem(`hubble-draft:${id}`, '{"broken":true}'));
    const brokenWorkspace = JSON.stringify({ openIds: 'broken', activeId: null, draftIds: ids });
    localStorage.setItem('hubble-workspace', brokenWorkspace);

    expect(readDraftRestoreResult().snapshot).toBeNull();

    expect(localStorage.getItem('hubble-workspace-backup')).toBe(brokenWorkspace);
    expect(ids.every((id) => localStorage.getItem(`hubble-draft:${id}`) !== null)).toBe(true);

    localStorage.setItem(
      'hubble-workspace',
      JSON.stringify({ version: 1, openIds: [], activeId: null, draftIds: [] }),
    );
    readDraftRestoreResult();
    expect(ids.every((id) => localStorage.getItem(`hubble-draft:${id}`) !== null)).toBe(true);
  });

  test('パース不能な孤立rawを日時不明の最新データとして残す', () => {
    localStorage.setItem(
      'hubble-workspace',
      JSON.stringify({ version: 1, openIds: [], activeId: null, draftIds: [] }),
    );
    localStorage.setItem('hubble-draft:corrupt', '{broken');
    for (let index = 0; index < 5; index += 1) {
      const id = `valid-${index}`;
      localStorage.setItem(
        `hubble-draft:${id}`,
        JSON.stringify(
          makeNotebook({ id, updatedAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString() }),
        ),
      );
    }

    readDraftRestoreResult();

    expect(localStorage.getItem('hubble-draft:corrupt')).toBe('{broken');
    expect(localStorage.getItem('hubble-draft:valid-0')).toBeNull();
  });

  test('epoch 0のupdatedAtを最古として掃除する', () => {
    localStorage.setItem(
      'hubble-workspace',
      JSON.stringify({ version: 1, openIds: [], activeId: null, draftIds: [] }),
    );
    localStorage.setItem(
      'hubble-draft:epoch',
      JSON.stringify(makeNotebook({ id: 'epoch', updatedAt: '1970-01-01T00:00:00.000Z' })),
    );
    for (let index = 0; index < 5; index += 1) {
      const id = `new-${index}`;
      localStorage.setItem(
        `hubble-draft:${id}`,
        JSON.stringify(
          makeNotebook({ id, updatedAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString() }),
        ),
      );
    }

    readDraftRestoreResult();

    expect(localStorage.getItem('hubble-draft:epoch')).toBeNull();
    expect(localStorage.getItem('hubble-draft:new-0')).not.toBeNull();
  });

  test('revisionがないdraftを破損として復元対象から外す', () => {
    const legacy = { ...makeNotebook({ id: 'legacy' }) } as Partial<Notebook>;
    delete legacy.revision;
    localStorage.setItem(
      'hubble-workspace',
      JSON.stringify({
        version: 1,
        openIds: ['legacy'],
        activeId: 'legacy',
        draftIds: ['legacy'],
      }),
    );
    localStorage.setItem('hubble-draft:legacy', JSON.stringify(legacy));

    expect(readDraftRestoreResult()).toMatchObject({ drafts: [], corruptIds: ['legacy'] });
  });
});

describe('setCellResultMeta (resultMeta write-back)', () => {
  test('writes a summary into the owning notebook cell', () => {
    useNotebookStore.getState().openNotebook(makeNotebook({ id: 'a' }));
    useNotebookStore.getState().setCellResultMeta('c1', {
      state: 'finished',
      rowCount: 25,
      elapsedMs: 120,
      executedAt: '2026-06-12T01:00:00.000Z',
    });
    const cell = useNotebookStore.getState().open['a']!.notebook.cells.find((c) => c.id === 'c1');
    expect(cell?.resultMeta).toEqual({
      state: 'finished',
      rowCount: 25,
      elapsedMs: 120,
      executedAt: '2026-06-12T01:00:00.000Z',
    });
    // The owning notebook is marked dirty so the summary rides the next persist.
    expect(useNotebookStore.getState().open['a']!.dirty).toBe(true);
  });

  test('finds the right notebook across open tabs and ignores unknown cells', () => {
    const st = useNotebookStore.getState();
    st.openNotebook(makeNotebook({ id: 'a', cells: [{ id: 'ca', kind: 'sql', source: 'X' }] }));
    st.openNotebook(makeNotebook({ id: 'b', cells: [{ id: 'cb', kind: 'sql', source: 'Y' }] }));
    useNotebookStore.getState().setCellResultMeta('cb', { state: 'failed', errorMessage: 'boom' });
    expect(useNotebookStore.getState().open['b']!.notebook.cells[0]!.resultMeta?.errorMessage).toBe(
      'boom',
    );
    // Cell in the other notebook untouched.
    expect(useNotebookStore.getState().open['a']!.notebook.cells[0]!.resultMeta).toBeUndefined();
    // Unknown cell id is a no-op (no throw).
    expect(() =>
      useNotebookStore.getState().setCellResultMeta('nope', { state: 'finished' }),
    ).not.toThrow();
  });
});

describe('setCellChart (チャート設定の永続化)', () => {
  const chart = {
    type: 'bars' as const,
    xIndex: 0,
    yIndices: [1],
    sort: 'none' as const,
    limit: 'all' as const,
    groupIndex: null,
    sizeIndex: null,
  };

  test('writes the chart config into the owning notebook cell and marks dirty', () => {
    useNotebookStore.getState().openNotebook(makeNotebook({ id: 'a' }));
    useNotebookStore.getState().setCellChart('c1', chart);
    const cell = useNotebookStore.getState().open['a']!.notebook.cells.find((c) => c.id === 'c1');
    expect(cell?.chart).toEqual(chart);
    // ユーザーコンテンツの変更なので dirty になり、次回の永続化に乗る。
    expect(useNotebookStore.getState().open['a']!.dirty).toBe(true);
  });

  test('unknown cell id is a no-op', () => {
    useNotebookStore.getState().openNotebook(makeNotebook({ id: 'a' }));
    expect(() => useNotebookStore.getState().setCellChart('nope', chart)).not.toThrow();
    expect(useNotebookStore.getState().open['a']!.dirty).toBe(false);
  });
});
