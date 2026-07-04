// Imperative notebook actions shared by the TopBar, command palette and global
// shortcuts. These read the store
// imperatively (getState) so they have stable identity and never re-render their
// callers. Run-all and save policy live here so every entry point behaves the
// same.
//
// ==== ファイルの責務（日本語） ================================================
// TopBar、コマンドパレット、グローバルショートカットから共有される、
// notebook に対する命令的なアクション群。ストアを React フックとして購読するのではなく `getState()` で
// 直接読み書きするため、これらの関数自体は参照が安定しており、呼び出し元の
// 再レンダーを引き起こさない。「全セル実行」「アクティブセルの実行」
// 「保存」といった、どのエントリポイント（ボタン/ショートカット/パレット）
// から呼ばれても同じ挙動になるべきポリシーをここに集約している。
// ============================================================================

import { useNotebookStore, persistSavedNotebook, substituteVariables } from '.';
import {
  allUnits,
  executionActions,
  getCellBlock,
  isCellRunning,
  useExecutionStore,
} from '../execution';
import type { ExecutionContext, ExecutionUnit } from '../execution';
import { getActiveEditor } from '../editor/activeEditor';
import { toast } from '../components/common/Toast';

/** Toast + return true when a cell is blocked by Query Guard (UX guard). */
/**
 * セルが Query Guard によってブロックされていればトースト通知して true を
 * 返す（UX 上のガード）。呼び出し元はこれを見て実行を中止する。
 */
function refuseIfBlocked(cellId: string): boolean {
  const block = getCellBlock(cellId);
  if (!block) return false;
  toast.error('Blocked by Query Guard', block.reasons[0] ?? 'This query exceeds the scan limit.');
  return true;
}

/** Resolve variables for a notebook's cell, or null if any are missing. */
/**
 * セルのソースを実行単位に分割し、それぞれの変数プレースホルダーを
 * `values` で置換する。いずれかの実行単位に未解決の変数があればトースト
 * 通知して null を返す（呼び出し元はこれを見て実行全体を中止する）。
 */
function resolveCellUnits(source: string, values: Record<string, string>): ExecutionUnit[] | null {
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
 * first failure. Markdown
 * cells are skipped. Returns when the batch settles.
 */
export async function runAllCells(
  context: { catalog?: string; schema?: string; datasourceId?: string },
  defaultLimit: number,
): Promise<void> {
  const store = useNotebookStore.getState();
  const entry = store.activeId ? store.open[store.activeId] : undefined;
  if (!entry) return; // 開いている notebook が無ければ何もしない。
  const notebook = entry.notebook;
  // 現在の変数入力値を name → value の Map 形式に変換しておく。
  const values: Record<string, string> = {};
  for (const v of notebook.variables) values[v.name] = v.value;

  const ctx: ExecutionContext = { ...context, notebookId: notebook.id };
  const opts = { autoLimit: true, limit: defaultLimit };
  // markdown セルは実行対象外。SQL セルのみを上から順に処理する。
  const sqlCells = notebook.cells.filter((c) => c.kind === 'sql');

  for (const cell of sqlCells) {
    // Query Guard: a blocked cell halts the notebook run (same as a failure).
    // Query Guard でブロックされているセルに達したら、そこで notebook 全体の
    // 実行を打ち切る（失敗扱いと同様の停止）。
    if (refuseIfBlocked(cell.id)) return;
    const units = resolveCellUnits(cell.source, values);
    if (units === null) return; // missing variable — abort the whole run
    if (units.length === 0) continue; // 空セルはスキップして次へ。
    // このセル内の実行単位（複数ステートメント）を逐次実行し、完了を待つ。
    await executionActions().runUnits(cell.id, units, ctx, opts);
    // Stop the notebook run at the first cell that didn't finish cleanly.
    // セルが finished 以外の終端状態（failed/canceled）で終わったら、
    // 以降のセルは実行せず notebook 全体の実行を止める（Hue 互換の挙動）。
    const exec = useExecutionStore.getState().cells[cell.id];
    if (!exec || exec.state !== 'finished') break;
  }
}

/**
 * Run the "active" SQL cell of the active notebook (Ctrl/Cmd+Enter
 * when focus is *not* inside an editor or a variable input). The target is the
 * cell whose editor was last focused (activeEditor registry), else the first SQL
 * cell. Variables are substituted; a missing value aborts with a toast.
 */
export function runActiveSqlCell(
  context: { catalog?: string; schema?: string; datasourceId?: string },
  defaultLimit: number,
): void {
  const store = useNotebookStore.getState();
  const entry = store.activeId ? store.open[store.activeId] : undefined;
  if (!entry) return;
  const notebook = entry.notebook;
  // 直前にフォーカスされていたエディタのセルを優先し、無ければ最初の SQL セルを使う。
  const focusedCellId = getActiveEditor()?.cellId;
  const cell =
    (focusedCellId && notebook.cells.find((c) => c.id === focusedCellId && c.kind === 'sql')) ||
    notebook.cells.find((c) => c.kind === 'sql');
  if (!cell || cell.kind !== 'sql') return;
  // Query Guard: refuse a blocked active cell (the toast explains why).
  if (refuseIfBlocked(cell.id)) return;

  const values: Record<string, string> = {};
  for (const v of notebook.variables) values[v.name] = v.value;
  const units = resolveCellUnits(cell.source, values);
  if (units === null) return; // missing variable — toast already shown
  if (units.length === 0) return;

  const ctx: ExecutionContext = { ...context, notebookId: notebook.id };
  const opts = { autoLimit: true, limit: defaultLimit };
  // 実行単位が 1 個ならシンプルな単発実行、複数あれば逐次実行（バッチ）にする。
  if (units.length === 1) executionActions().runUnit(cell.id, units[0]!, ctx, opts);
  else void executionActions().runUnits(cell.id, units, ctx, opts);
}

/** True when any SQL cell of the active notebook is currently running. */
/** アクティブな notebook のいずれかの SQL セルが現在実行中であれば true。 */
export function isActiveNotebookRunning(): boolean {
  const store = useNotebookStore.getState();
  const entry = store.activeId ? store.open[store.activeId] : undefined;
  if (!entry) return false;
  const execCells = useExecutionStore.getState().cells;
  return entry.notebook.cells.some((c) => isCellRunning(execCells[c.id]));
}

/** Cancel every running cell of the active notebook (Run → Stop). */
/** アクティブな notebook 内で実行中のすべてのセルをキャンセルする（Run → Stop ボタン用）。 */
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
  if (!id || !entry) return { noop: true }; // 開いている notebook が無い。
  // draft はまだ名前を持たない可能性があるため、先に保存モーダルで名前を
  // 確定させる必要がある。呼び出し元にそれを伝える。
  if (entry.draft) return { needsName: true, id };
  const saved = await persistSavedNotebook(id);
  if (saved) {
    toast.success('Saved', `“${saved.name}” saved.`);
    return { saved: true };
  }
  toast.error('Save failed', 'Could not reach the server.');
  return { noop: true };
}
