// Notebook store (design.md §3 状態分割, §4 データモデル, §5 管理). One zustand
// store owns every *open* notebook (the TopBar tabs), the active id, and each
// open notebook's dirty / draft / saving state. Cell CRUD, reordering, variable
// values and the title/description all flow through here.
//
// Persistence policy (design.md §4, §5):
//   - A *saved* notebook (has a server id, `draft === false`) is autosaved with a
//     2s debounce via PUT, and on an explicit Ctrl/Cmd+S.
//   - A *draft* notebook (never persisted, `draft === true`) is kept in
//     localStorage so a reload restores it; the first explicit save POSTs it and
//     flips it to a saved notebook.
//   - The set of open tabs + the active id are mirrored to localStorage so a
//     reload reopens the same workspace.
//
// Network calls are injected (`__setPersistence`) so the store is unit-testable
// with fake timers and no fetch. Components read via the selector hooks at the
// end; cell-execution lifecycle (clear on delete) is the caller's job — the
// store stays free of the execution layer to avoid a cycle.

import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type {
  Cell,
  CellKind,
  CellResultMeta,
  Notebook,
  NotebookContext,
  Variable,
} from '@hue-fable/contracts';
import { uid } from '../utils/id';
import { detectVariables, reconcileVariables } from './variables';
import { readRecentContexts } from './recentContexts';

// ---- Persistence injection --------------------------------------------------

/** The network surface the store needs; injected so tests can stub it. */
export interface NotebookPersistence {
  create: (nb: Notebook) => Promise<Notebook>;
  update: (id: string, nb: Notebook) => Promise<Notebook>;
}

let persistence: NotebookPersistence | null = null;
/** Wire the real API (or a stub in tests). Call once at app start. */
export function __setPersistence(p: NotebookPersistence | null): void {
  persistence = p;
}

/** Autosave debounce window (design.md §4: debounce 2s). */
export const AUTOSAVE_DEBOUNCE_MS = 2000;

// ---- localStorage keys ------------------------------------------------------

const WORKSPACE_KEY = 'hue-fable-workspace'; // open tab ids + active id
const DRAFT_PREFIX = 'hue-fable-draft:'; // per-draft notebook snapshot

// ---- Open-notebook record ---------------------------------------------------

/** An open notebook plus its editing state. */
export interface OpenNotebook {
  notebook: Notebook;
  /** Has unsaved changes since the last successful persist. */
  dirty: boolean;
  /** True until first persisted to the server (then it has a real id + PUTs). */
  draft: boolean;
  /** A save (POST/PUT) is in flight. */
  saving: boolean;
}

interface NotebookStoreState {
  /** Open notebooks keyed by id, in no particular order (order is `openIds`). */
  open: Record<string, OpenNotebook>;
  /** Tab order (left→right). */
  openIds: string[];
  activeId: string | null;

  // Lifecycle
  openNotebook: (notebook: Notebook, opts?: { draft?: boolean; activate?: boolean }) => void;
  closeNotebook: (id: string) => void;
  setActive: (id: string) => void;
  createBlankNotebook: () => string;

  // Notebook-level edits
  renameNotebook: (id: string, name: string) => void;
  setDescription: (id: string, description: string) => void;
  setContext: (id: string, context: NotebookContext) => void;

  // Cell edits
  addCell: (
    id: string,
    kind: CellKind,
    position?: { relativeTo: string; where: 'above' | 'below' } | 'end',
  ) => string;
  removeCell: (id: string, cellId: string) => void;
  moveCell: (id: string, from: number, to: number) => void;
  setCellSource: (id: string, cellId: string, source: string) => void;
  setCellName: (id: string, cellId: string, name: string) => void;
  toggleCellCollapsed: (id: string, cellId: string) => void;
  /** Write the last-execution summary into a cell (design.md §4 resultMeta). */
  setCellResultMeta: (cellId: string, meta: CellResultMeta) => void;

  // Variables
  setVariableValue: (id: string, name: string, value: string) => void;

  // Persistence
  markSaved: (id: string, persisted: Notebook) => void;
  setSaving: (id: string, saving: boolean) => void;
}

// ---- Pure helpers (exported for tests) --------------------------------------

/** A fresh blank notebook with one empty SQL cell (design.md §1 初回起動). */
export function blankNotebook(context: NotebookContext = {}): Notebook {
  const now = new Date().toISOString();
  return {
    id: uid('nb'),
    name: 'Untitled notebook',
    description: '',
    cells: [{ id: uid('cell'), kind: 'sql', source: '' }],
    variables: [],
    context,
    createdAt: now,
    updatedAt: now,
  };
}

/** A new empty cell of the given kind with a stable id. */
function newCell(kind: CellKind): Cell {
  return { id: uid('cell'), kind, source: '' };
}

/** Recompute `notebook.variables` from its SQL cells, preserving typed values. */
export function recomputeVariables(notebook: Notebook): Variable[] {
  const sqlSources = notebook.cells.filter((c) => c.kind === 'sql').map((c) => c.source);
  const detected = detectVariables(sqlSources);
  return reconcileVariables(detected, notebook.variables);
}

/** Move an array element from `from` to `to`, returning a new array. */
export function moveItem<T>(arr: readonly T[], from: number, to: number): T[] {
  const next = arr.slice();
  if (from < 0 || from >= next.length || to < 0 || to >= next.length) return next;
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

// ---- Draft / workspace persistence (localStorage) ---------------------------

interface WorkspaceSnapshot {
  openIds: string[];
  activeId: string | null;
  /** Which of the open ids are drafts (so we know to load from DRAFT_PREFIX). */
  draftIds: string[];
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function writeWorkspace(state: NotebookStoreState): void {
  const ls = safeLocalStorage();
  if (!ls) return;
  const draftIds = state.openIds.filter((id) => state.open[id]?.draft);
  const snapshot: WorkspaceSnapshot = {
    openIds: state.openIds,
    activeId: state.activeId,
    draftIds,
  };
  try {
    ls.setItem(WORKSPACE_KEY, JSON.stringify(snapshot));
  } catch {
    /* quota / serialization — non-fatal */
  }
}

function writeDraft(notebook: Notebook): void {
  const ls = safeLocalStorage();
  if (!ls) return;
  try {
    ls.setItem(`${DRAFT_PREFIX}${notebook.id}`, JSON.stringify(notebook));
  } catch {
    /* non-fatal */
  }
}

function removeDraft(id: string): void {
  safeLocalStorage()?.removeItem(`${DRAFT_PREFIX}${id}`);
}

function readDraft(id: string): Notebook | null {
  const ls = safeLocalStorage();
  if (!ls) return null;
  const raw = ls.getItem(`${DRAFT_PREFIX}${id}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Notebook;
  } catch {
    return null;
  }
}

/** The persisted workspace snapshot (open tab ids + active), or null. */
export function readWorkspaceSnapshot(): WorkspaceSnapshot | null {
  const ls = safeLocalStorage();
  if (!ls) return null;
  const raw = ls.getItem(WORKSPACE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as WorkspaceSnapshot;
  } catch {
    return null;
  }
}

/** Read all restorable draft notebooks named in the workspace snapshot. */
export function readDrafts(): Notebook[] {
  const snapshot = readWorkspaceSnapshot();
  if (!snapshot) return [];
  return snapshot.draftIds
    .map((id) => readDraft(id))
    .filter((nb): nb is Notebook => nb !== null);
}

// ---- Autosave scheduling ----------------------------------------------------

// Per-notebook debounce timers live outside the reactive store so scheduling a
// save never triggers a render.
const autosaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearAutosave(id: string): void {
  const t = autosaveTimers.get(id);
  if (t) {
    clearTimeout(t);
    autosaveTimers.delete(id);
  }
}

// ---- Store ------------------------------------------------------------------

export const useNotebookStore = create<NotebookStoreState>((set, get) => {
  /** Replace one open notebook's `notebook`, recompute variables, mark dirty. */
  const mutate = (
    id: string,
    fn: (nb: Notebook) => Notebook,
    opts: { touch?: boolean } = {},
  ): void => {
    const entry = get().open[id];
    if (!entry) return;
    let next = fn(entry.notebook);
    next = { ...next, variables: recomputeVariables(next) };
    if (opts.touch !== false) next = { ...next, updatedAt: new Date().toISOString() };
    set((s) => ({ open: { ...s.open, [id]: { ...entry, notebook: next, dirty: true } } }));
    afterChange(id);
  };

  /** After any change: persist the draft locally and (if saved) schedule a PUT. */
  const afterChange = (id: string): void => {
    const entry = get().open[id];
    if (!entry) return;
    if (entry.draft) {
      writeDraft(entry.notebook);
    } else {
      scheduleAutosave(id);
    }
  };

  /** Debounced PUT for a saved notebook (design.md §4: 2s debounce). */
  const scheduleAutosave = (id: string): void => {
    clearAutosave(id);
    const timer = setTimeout(() => {
      autosaveTimers.delete(id);
      void saveNow(id);
    }, AUTOSAVE_DEBOUNCE_MS);
    autosaveTimers.set(id, timer);
  };

  /** Persist immediately via PUT (saved notebooks only). */
  const saveNow = async (id: string): Promise<void> => {
    const entry = get().open[id];
    if (!entry || entry.draft || !persistence) return;
    if (!entry.dirty) return;
    set((s) => ({ open: { ...s.open, [id]: { ...entry, saving: true } } }));
    try {
      const saved = await persistence.update(id, entry.notebook);
      get().markSaved(id, saved);
    } catch {
      // Keep dirty; a later edit reschedules. Surface via toast at the call site.
      const cur = get().open[id];
      if (cur) set((s) => ({ open: { ...s.open, [id]: { ...cur, saving: false } } }));
    }
  };

  return {
    open: {},
    openIds: [],
    activeId: null,

    openNotebook: (notebook, opts = {}) => {
      const { draft = false, activate = true } = opts;
      const existing = get().open[notebook.id];
      set((s) => {
        const open = {
          ...s.open,
          [notebook.id]: existing
            ? { ...existing }
            : { notebook, dirty: false, draft, saving: false },
        };
        const openIds = s.openIds.includes(notebook.id)
          ? s.openIds
          : [...s.openIds, notebook.id];
        return {
          open,
          openIds,
          activeId: activate ? notebook.id : s.activeId ?? notebook.id,
        };
      });
      writeWorkspace(get());
    },

    closeNotebook: (id) => {
      clearAutosave(id);
      const entry = get().open[id];
      if (entry?.draft) removeDraft(id);
      set((s) => {
        const open = { ...s.open };
        delete open[id];
        const openIds = s.openIds.filter((x) => x !== id);
        let activeId = s.activeId;
        if (activeId === id) {
          const idx = s.openIds.indexOf(id);
          activeId = openIds[Math.min(idx, openIds.length - 1)] ?? null;
        }
        return { open, openIds, activeId };
      });
      writeWorkspace(get());
    },

    setActive: (id) => {
      if (!get().open[id]) return;
      set({ activeId: id });
      writeWorkspace(get());
    },

    createBlankNotebook: () => {
      // Seed the new notebook's context from the active notebook, falling back to
      // the most-recently-used context (design.md §5: 最近使った値を新規 notebook
      // の初期値に).
      const active = get().activeId ? get().open[get().activeId!]?.notebook.context : undefined;
      const ctx =
        active && (active.catalog || active.schema) ? active : (readRecentContexts()[0] ?? {});
      const nb = blankNotebook(ctx);
      get().openNotebook(nb, { draft: true, activate: true });
      writeDraft(nb);
      return nb.id;
    },

    renameNotebook: (id, name) => {
      mutate(id, (nb) => ({ ...nb, name: name.trim() || 'Untitled notebook' }));
    },

    setDescription: (id, description) => {
      mutate(id, (nb) => ({ ...nb, description }));
    },

    setContext: (id, context) => {
      mutate(id, (nb) => ({ ...nb, context }));
    },

    addCell: (id, kind, position = 'end') => {
      const cell = newCell(kind);
      mutate(id, (nb) => {
        if (position === 'end') return { ...nb, cells: [...nb.cells, cell] };
        const idx = nb.cells.findIndex((c) => c.id === position.relativeTo);
        if (idx === -1) return { ...nb, cells: [...nb.cells, cell] };
        const at = position.where === 'above' ? idx : idx + 1;
        const cells = nb.cells.slice();
        cells.splice(at, 0, cell);
        return { ...nb, cells };
      });
      return cell.id;
    },

    removeCell: (id, cellId) => {
      mutate(id, (nb) => ({ ...nb, cells: nb.cells.filter((c) => c.id !== cellId) }));
    },

    moveCell: (id, from, to) => {
      mutate(id, (nb) => ({ ...nb, cells: moveItem(nb.cells, from, to) }));
    },

    setCellSource: (id, cellId, source) => {
      mutate(id, (nb) => ({
        ...nb,
        cells: nb.cells.map((c) => (c.id === cellId ? { ...c, source } : c)),
      }));
    },

    setCellName: (id, cellId, name) => {
      mutate(id, (nb) => ({
        ...nb,
        cells: nb.cells.map((c) =>
          c.id === cellId ? { ...c, name: name.trim() ? name : undefined } : c,
        ),
      }));
    },

    toggleCellCollapsed: (id, cellId) => {
      mutate(id, (nb) => ({
        ...nb,
        cells: nb.cells.map((c) =>
          c.id === cellId ? { ...c, collapsed: !c.collapsed } : c,
        ),
      }));
    },

    setCellResultMeta: (cellId, meta) => {
      // Locate the open notebook that owns this cell (cellId is globally unique).
      const state = get();
      const ownerId = state.openIds.find((nbId) =>
        state.open[nbId]?.notebook.cells.some((c) => c.id === cellId),
      );
      if (!ownerId) return;
      const entry = state.open[ownerId];
      if (!entry) return;
      const cells = entry.notebook.cells.map((c) =>
        c.id === cellId ? { ...c, resultMeta: meta } : c,
      );
      // resultMeta is a derived summary, not user content — don't bump updatedAt
      // or recompute variables. It still rides along on the next persist.
      const next = { ...entry.notebook, cells };
      set((s) => ({ open: { ...s.open, [ownerId]: { ...entry, notebook: next, dirty: true } } }));
      afterChange(ownerId);
    },

    setVariableValue: (id, name, value) => {
      // A value change doesn't alter the SQL, so skip the variable recompute and
      // update only the matching variable's value.
      const entry = get().open[id];
      if (!entry) return;
      const variables = entry.notebook.variables.map((v) =>
        v.name === name ? { ...v, value } : v,
      );
      const next = {
        ...entry.notebook,
        variables,
        updatedAt: new Date().toISOString(),
      };
      set((s) => ({ open: { ...s.open, [id]: { ...entry, notebook: next, dirty: true } } }));
      afterChange(id);
    },

    markSaved: (id, persisted) => {
      clearAutosave(id);
      const entry = get().open[id];
      if (!entry) return;
      const wasDraft = entry.draft;
      // The server may have assigned a new id (POST). Re-key under it.
      const newKey = persisted.id;
      set((s) => {
        const open = { ...s.open };
        delete open[id];
        open[newKey] = { notebook: persisted, dirty: false, draft: false, saving: false };
        const openIds = s.openIds.map((x) => (x === id ? newKey : x));
        const activeId = s.activeId === id ? newKey : s.activeId;
        return { open, openIds, activeId };
      });
      if (wasDraft) removeDraft(id);
      writeWorkspace(get());
    },

    setSaving: (id, saving) => {
      const entry = get().open[id];
      if (!entry) return;
      set((s) => ({ open: { ...s.open, [id]: { ...entry, saving } } }));
    },
  };
});

// ---- Imperative save helpers (used by Ctrl+S / Save buttons) ----------------

/**
 * Persist a draft notebook for the first time (POST) under a chosen name, then
 * re-key it as a saved notebook. Returns the persisted notebook, or null when
 * persistence isn't wired.
 */
export async function persistNewNotebook(id: string, name: string): Promise<Notebook | null> {
  if (!persistence) return null;
  const store = useNotebookStore.getState();
  const entry = store.open[id];
  if (!entry) return null;
  store.setSaving(id, true);
  const body = { ...entry.notebook, name: name.trim() || 'Untitled notebook' };
  try {
    const saved = await persistence.create(body);
    store.markSaved(id, saved);
    return saved;
  } catch {
    store.setSaving(id, false);
    return null;
  }
}

/**
 * Persist an already-saved notebook now (PUT), bypassing the debounce. Returns
 * the persisted notebook, or null on failure / when not wired.
 */
export async function persistSavedNotebook(id: string): Promise<Notebook | null> {
  if (!persistence) return null;
  const store = useNotebookStore.getState();
  const entry = store.open[id];
  if (!entry || entry.draft) return null;
  clearAutosave(id);
  store.setSaving(id, true);
  try {
    const saved = await persistence.update(id, entry.notebook);
    store.markSaved(id, saved);
    return saved;
  } catch {
    store.setSaving(id, false);
    return null;
  }
}

// ---- Selector hooks ---------------------------------------------------------

/** The currently active open notebook, or undefined. */
export function useActiveNotebook(): OpenNotebook | undefined {
  return useNotebookStore((s) => (s.activeId ? s.open[s.activeId] : undefined));
}

/**
 * Tab descriptors for the TopBar (id, name, dirty), in tab order. We subscribe
 * to the stable `openIds` + `open` references with `useShallow` and derive the
 * descriptor objects in render — returning fresh objects from the selector would
 * defeat `useShallow`'s element-wise comparison and loop.
 */
export function useNotebookTabs(): { id: string; name: string; dirty: boolean }[] {
  const openIds = useNotebookStore(useShallow((s) => s.openIds));
  const open = useNotebookStore((s) => s.open);
  return openIds
    .filter((id) => open[id])
    .map((id) => {
      const e = open[id]!;
      return { id, name: e.notebook.name, dirty: e.dirty };
    });
}
