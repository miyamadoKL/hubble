// Imperative "drop SQL into the notebook" actions shared by the Data browser,
// Saved queries and History panels (design.md §5: クリックでカーソル位置に挿入 /
// 新規セルへ). They read the notebook store imperatively so the sidebar panels
// stay decoupled from React state, and they centralise the "no active cell →
// toast" policy so every entry point behaves the same.
//
// ==== ファイルの責務（日本語） ================================================
// Data browser、Saved queries、History の各サイドバーパネルから共有される、
// 「SQL テキストを notebook へ挿入する」ための命令的（imperative）アクション群。
// notebook ストアを React の状態購読ではなく `getState()` で直接読み書きする
// ことで、サイドバーパネル側が React の再レンダーサイクルに縛られずに操作
// できるようにしている。また「アクティブなセルが無い場合はトースト通知する」
// というポリシーをここに集約し、どの呼び出し元からでも同じ挙動になるように
// している。
// ============================================================================

import { useNotebookStore } from './notebookStore';
import { insertAtCursor } from '../editor/activeEditor';
import { toast } from '../components/common/Toast';

/**
 * Insert `text` at the active SQL editor's caret (design.md §5: カーソル位置に
 * 挿入). When no editor is focused, toasts and returns false so the caller can
 * fall back to a new cell.
 *
 * 現在フォーカスされている SQL エディタのキャレット位置に `text` を挿入する。
 * どのエディタもフォーカスされていない場合はトーストで通知し false を返す。
 * 呼び出し側はこの false を見て「新規セルへ挿入」にフォールバックできる。
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
 *
 * アクティブな notebook の末尾に、`source` を初期値とした新しい SQL セルを
 * 追加する。開いている notebook が無ければトースト通知して null を返す。
 * 追加後は新規セルの id を返し、呼び出し側でフォーカス移動などに使える。
 */
export function addSqlCellWithSource(source: string): string | null {
  const store = useNotebookStore.getState();
  const id = store.activeId;
  if (!id) {
    toast.info('No notebook open', 'Create a notebook first.');
    return null;
  }
  // まず空の SQL セルを末尾に追加し、続けてそのセルのソースを書き換える。
  const cellId = store.addCell(id, 'sql', 'end');
  store.setCellSource(id, cellId, source);
  return cellId;
}
