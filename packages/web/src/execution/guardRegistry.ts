// Query Guard block registry (Query Guard feature).
//
// The live estimate is computed inside each SqlCell (it owns the editor + parse
// state), but the *run entry points* that don't go through the cell's run button
// — run-all, the command palette, the global Ctrl/Cmd+Enter — must respect the
// same block. Threading the verdict up through React would couple unrelated
// layers, so each cell publishes its current "blocked" state here (keyed by
// cellId) and the imperative run helpers consult it before starting a query.
//
// This is a *UX* guard only: `enforce` mode on the server is the real wall (a
// blocked run still returns 422 QUERY_BLOCKED and is surfaced in the ErrorPanel).
// Framework-free so non-component code can read it.
//
// ==== ファイルの責務（日本語） ================================================
// Query Guard の「ブロック状態」を、セルをまたいで参照できるようにする
// レジストリ。ライブ見積りは各 SqlCell（エディタ本体 + パース状態を持つ）が
// 計算するが、セルの実行ボタン以外の実行経路（Run All、コマンドパレット、
// 全体の Ctrl/Cmd+Enter）も同じブロック判定を尊重する必要がある。verdict を
// React のツリーを通して受け渡すと本来疎結合であるべきレイヤー同士が結合して
// しまうため、代わりに各セルが現在のブロック状態を cellId をキーにここへ
// 「発行(publish)」し、実行系のヘルパー関数はクエリを開始する前にここを
// 参照する、という設計にしている。
// あくまで UX 上のガードであり、本当の壁はサーバー側の enforce モード
// （ブロックされた実行は 422 QUERY_BLOCKED を返し、ErrorPanel に表示される）。
// React コンポーネントに依存しないプレーンな実装にしてあるので、
// コンポーネント外のコードからも参照できる。
// ============================================================================

/** Why a cell is blocked, with the reasons to surface to the user. */
/** セルがブロックされている理由。ユーザーへ表示するための文字列群。 */
export interface CellBlock {
  reasons: string[];
}

// cellId → 現在のブロック状態。エントリが無いセルはブロックされていない。
const blocked = new Map<string, CellBlock>();

/** Mark a cell as blocked (or clear it when `block` is undefined). */
/**
 * セルをブロック状態としてマークする（`block` が undefined なら解除する）。
 * SqlCell がライブ見積りの結果を受けて呼び出す。
 */
export function setCellBlocked(cellId: string, block: CellBlock | undefined): void {
  if (block) blocked.set(cellId, block);
  else blocked.delete(cellId);
}

/** The block for a cell, or undefined when it may run. */
/** セルの現在のブロック情報。実行可能であれば undefined。 */
export function getCellBlock(cellId: string): CellBlock | undefined {
  return blocked.get(cellId);
}

/** True when the cell is currently blocked by Query Guard. */
/** セルが現在 Query Guard によってブロックされているかどうか。 */
export function isCellBlocked(cellId: string): boolean {
  return blocked.has(cellId);
}

/** Drop a cell's registration entirely (on unmount / delete). */
/** セルの登録を完全に削除する（アンマウント時やセル削除時に呼ぶ）。 */
export function clearCellBlock(cellId: string): void {
  blocked.delete(cellId);
}
