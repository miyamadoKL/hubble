// Imperative notebook actions shared by the TopBar, command palette and global
// shortcuts (design.md §5 管理, §6 コマンドパレット). These read the store
// imperatively (getState) so they have stable identity and never re-render their
// callers. Run-all and save policy live here so every entry point behaves the
// same.

import {
  useNotebookStore,
  persistSavedNotebook,
  substituteVariables,
} from '.';
import { allUnits, executionActions, isCellRunning, useExecutionStore } from '../execution';
import type { ExecutionContext, ExecutionUnit } from '../execution';
import { getActiveEditor } from '../editor/activeEditor';
import { toast } from '../components/common/Toast';

/** Resolve variables for a notebook's cell, or null if any are missing. */
function resolveCellUnits(
  source: string,
  values: Record<string, string>,
): ExecutionUnit[] | null {
  const resolved: ExecutionUnit[] = [];
  for (const u of allUnits(source)) {
    const { text, missing } = substituteVariables(u.text, values);
    if (missing.length > 0) {
      toast.error(
        'Missing variable value',
        `Provide a value for ${missing.map((m) => `\${${m}}`).join(', ')} before running.`,
      );
      return null;
    }
    resolved.push({ ...u, text });
  }
  return resolved;
}

/**
 * Run every SQL cell of the active notebook, top to bottom, stopping at the
 * first failure (design.md §5: 全セル実行 — 上から順次, エラーで停止). Markdown
 * cells are skipped. Returns when the batch settles.
 */
export async function runAllCells(
  context: { catalog?: string; schema?: string },
  defaultLimit: number,
): Promise<void> {
  const store = useNotebookStore.getState();
  const entry = store.activeId ? store.open[store.activeId] : undefined;
  if (!entry) return;
  const notebook = entry.notebook;
  const values: Record<string, string> = {};
  for (const v of notebook.variables) values[v.name] = v.value;

  const ctx: ExecutionContext = { ...context, notebookId: notebook.id };
  const opts = { autoLimit: true, limit: defaultLimit };
  const sqlCells = notebook.cells.filter((c) => c.kind === 'sql');

  for (const cell of sqlCells) {
    const units = resolveCellUnits(cell.source, values);
    if (units === null) return; // missing variable — abort the whole run
    if (units.length === 0) continue;
    await executionActions().runUnits(cell.id, units, ctx, opts);
    // Stop the notebook run at the first cell that didn't finish cleanly.
    const exec = useExecutionStore.getState().cells[cell.id];
    if (!exec || exec.state !== 'finished') break;
  }
}

/**
 * Run the "active" SQL cell of the active notebook (design.md §5 Ctrl/Cmd+Enter
 * when focus is *not* inside an editor or a variable input). The target is the
 * cell whose editor was last focused (activeEditor registry), else the first SQL
 * cell. Variables are substituted; a missing value aborts with a toast.
 */
export function runActiveSqlCell(
  context: { catalog?: string; schema?: string },
  defaultLimit: number,
): void {
  const store = useNotebookStore.getState();
  const entry = store.activeId ? store.open[store.activeId] : undefined;
  if (!entry) return;
  const notebook = entry.notebook;
  const focusedCellId = getActiveEditor()?.cellId;
  const cell =
    (focusedCellId && notebook.cells.find((c) => c.id === focusedCellId && c.kind === 'sql')) ||
    notebook.cells.find((c) => c.kind === 'sql');
  if (!cell || cell.kind !== 'sql') return;

  const values: Record<string, string> = {};
  for (const v of notebook.variables) values[v.name] = v.value;
  const units = resolveCellUnits(cell.source, values);
  if (units === null) return; // missing variable — toast already shown
  if (units.length === 0) return;

  const ctx: ExecutionContext = { ...context, notebookId: notebook.id };
  const opts = { autoLimit: true, limit: defaultLimit };
  if (units.length === 1) executionActions().runUnit(cell.id, units[0]!, ctx, opts);
  else void executionActions().runUnits(cell.id, units, ctx, opts);
}

/** True when any SQL cell of the active notebook is currently running. */
export function isActiveNotebookRunning(): boolean {
  const store = useNotebookStore.getState();
  const entry = store.activeId ? store.open[store.activeId] : undefined;
  if (!entry) return false;
  const execCells = useExecutionStore.getState().cells;
  return entry.notebook.cells.some((c) => isCellRunning(execCells[c.id]));
}

/** Cancel every running cell of the active notebook (Run → Stop). */
export function cancelActiveNotebook(): void {
  const store = useNotebookStore.getState();
  const entry = store.activeId ? store.open[store.activeId] : undefined;
  if (!entry) return;
  const execCells = useExecutionStore.getState().cells;
  for (const cell of entry.notebook.cells) {
    if (isCellRunning(execCells[cell.id])) executionActions().cancel(cell.id);
  }
}

/**
 * Save the active notebook. A saved notebook PUTs immediately; a draft needs a
 * name first, so this returns `{ needsName: true }` for the caller to open the
 * save modal. On a successful PUT it toasts and returns `{ saved: true }`.
 */
export async function saveActiveNotebook(): Promise<
  { saved: true } | { needsName: true; id: string } | { noop: true }
> {
  const store = useNotebookStore.getState();
  const id = store.activeId;
  const entry = id ? store.open[id] : undefined;
  if (!id || !entry) return { noop: true };
  if (entry.draft) return { needsName: true, id };
  const saved = await persistSavedNotebook(id);
  if (saved) {
    toast.success('Saved', `“${saved.name}” saved.`);
    return { saved: true };
  }
  toast.error('Save failed', 'Could not reach the server.');
  return { noop: true };
}
