// Imperative "drop SQL into the notebook" actions shared by the Data browser,
// Saved queries and History panels (design.md §5: クリックでカーソル位置に挿入 /
// 新規セルへ). They read the notebook store imperatively so the sidebar panels
// stay decoupled from React state, and they centralise the "no active cell →
// toast" policy so every entry point behaves the same.

import { useNotebookStore } from './notebookStore';
import { insertAtCursor } from '../editor/activeEditor';
import { toast } from '../components/common/Toast';

/**
 * Insert `text` at the active SQL editor's caret (design.md §5: カーソル位置に
 * 挿入). When no editor is focused, toasts and returns false so the caller can
 * fall back to a new cell.
 */
export function insertAtActiveCursor(text: string): boolean {
  const ok = insertAtCursor(text);
  if (!ok) {
    toast.info('No active SQL cell', 'Click into a SQL cell, then insert again.');
  }
  return ok;
}

/**
 * Add a new SQL cell to the active notebook seeded with `source`, returning its
 * id (or null when no notebook is open). Used by "SELECT 雛形を新規セルへ" and
 * "新規セルへ挿入" affordances.
 */
export function addSqlCellWithSource(source: string): string | null {
  const store = useNotebookStore.getState();
  const id = store.activeId;
  if (!id) {
    toast.info('No notebook open', 'Create a notebook first.');
    return null;
  }
  const cellId = store.addCell(id, 'sql', 'end');
  store.setCellSource(id, cellId, source);
  return cellId;
}
