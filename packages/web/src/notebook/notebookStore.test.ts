import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { notebookSchema, type Notebook } from '@hue-fable/contracts';
import {
  useNotebookStore,
  blankNotebook,
  moveItem,
  recomputeVariables,
  persistNewNotebook,
  persistSavedNotebook,
  AUTOSAVE_DEBOUNCE_MS,
  __setPersistence,
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
    ...over,
  };
}

beforeEach(() => {
  reset();
  __setPersistence(null);
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
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

  test('createBlankNotebook opens a draft with one empty SQL cell', () => {
    const id = useNotebookStore.getState().createBlankNotebook();
    const entry = useNotebookStore.getState().open[id];
    expect(entry?.draft).toBe(true);
    expect(entry?.notebook.cells).toHaveLength(1);
    expect(entry?.notebook.cells[0]?.kind).toBe('sql');
    expect(localStorage.getItem(`hue-fable-draft:${id}`)).not.toBeNull();
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
    useNotebookStore
      .getState()
      .setCellSource('nb-1', 'c1', 'SELECT * FROM t LIMIT ${n=10}');
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
    expect(useNotebookStore.getState().open['nb-1']?.dirty).toBe(false);
  });

  test('a draft notebook is NOT autosaved (kept in localStorage instead)', async () => {
    vi.useFakeTimers();
    const update = vi.fn(async (_id: string, nb: Notebook) => nb);
    __setPersistence({ create: vi.fn(async (nb) => nb), update });

    const id = useNotebookStore.getState().createBlankNotebook();
    useNotebookStore.getState().setCellSource(id, useNotebookStore.getState().open[id]!.notebook.cells[0]!.id, 'SELECT 9');
    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS * 2);
    await vi.runAllTimersAsync();

    expect(update).not.toHaveBeenCalled();
    expect(localStorage.getItem(`hue-fable-draft:${id}`)).toContain('SELECT 9');
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
    expect(localStorage.getItem(`hue-fable-draft:${id}`)).toBeNull();
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
});

describe('workspace persistence', () => {
  test('open tabs + active are mirrored to localStorage', () => {
    useNotebookStore.getState().openNotebook(makeNotebook({ id: 'a' }));
    useNotebookStore.getState().openNotebook(makeNotebook({ id: 'b' }));
    const snap = JSON.parse(localStorage.getItem('hue-fable-workspace')!);
    expect(snap.openIds).toEqual(['a', 'b']);
    expect(snap.activeId).toBe('b');
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
    expect(
      useNotebookStore.getState().open['b']!.notebook.cells[0]!.resultMeta?.errorMessage,
    ).toBe('boom');
    // Cell in the other notebook untouched.
    expect(useNotebookStore.getState().open['a']!.notebook.cells[0]!.resultMeta).toBeUndefined();
    // Unknown cell id is a no-op (no throw).
    expect(() =>
      useNotebookStore.getState().setCellResultMeta('nope', { state: 'finished' }),
    ).not.toThrow();
  });
});
