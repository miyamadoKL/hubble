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

/** Why a cell is blocked, with the reasons to surface to the user. */
export interface CellBlock {
  reasons: string[];
}

const blocked = new Map<string, CellBlock>();

/** Mark a cell as blocked (or clear it when `block` is undefined). */
export function setCellBlocked(cellId: string, block: CellBlock | undefined): void {
  if (block) blocked.set(cellId, block);
  else blocked.delete(cellId);
}

/** The block for a cell, or undefined when it may run. */
export function getCellBlock(cellId: string): CellBlock | undefined {
  return blocked.get(cellId);
}

/** True when the cell is currently blocked by Query Guard. */
export function isCellBlocked(cellId: string): boolean {
  return blocked.has(cellId);
}

/** Drop a cell's registration entirely (on unmount / delete). */
export function clearCellBlock(cellId: string): void {
  blocked.delete(cellId);
}
