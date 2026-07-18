/**
 * verticalDragResize.ts
 *
 * 縦方向（高さ）の pointer ドラッグリサイズを扱う汎用ヘルパー。結果表示域
 * （resultHeight.ts）と SQL エディター（editorHeight.ts）の両方の高さハンドルが
 * この関数を共有する。ドラッグ対象が「結果表示域」か「エディター」かに依存する
 * ロジックは一切含まず、pointer 座標の差分を高さの増分として渡すだけの
 * 純粋な pointer イベント配線に留めている。
 */

/**
 * 高さリサイズハンドルの pointer ドラッグを開始する。ポインタのY移動量をそのまま
 * 高さの増分として `setHeight` に渡す。呼び出し元は pointerup 時（または
 * unmount 時）に返り値の cleanup を呼ぶこと。
 *
 * `pointerId` はドラッグ開始時のポインタを特定するための識別子（React の
 * PointerEvent#pointerId をそのまま渡す想定）。マルチタッチ等で無関係な
 * pointermove/pointerup/pointercancel が飛んできても無視するために使う。
 * また `pointerup` だけでなく `pointercancel`（タッチスクロールへの切替や
 * ジェスチャー中断で発火する）でも同じ cleanup を呼び、window の event listener と
 * document.body.style の変更が unmount までリークしないようにする。
 */
export function beginVerticalDragResize(
  startY: number,
  startHeight: number,
  setHeight: (height: number) => void,
  onEnd: () => void = () => {},
  pointerId?: number,
): () => void {
  const previousCursor = document.body.style.cursor;
  const previousUserSelect = document.body.style.userSelect;
  let active = true;
  const onMove = (event: PointerEvent) => {
    if (active && event.pointerId === pointerId) {
      setHeight(startHeight + (event.clientY - startY));
    }
  };
  const cleanup = (event?: PointerEvent) => {
    if (!active) return;
    if (event && event.pointerId !== pointerId) return;
    active = false;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', cleanup);
    window.removeEventListener('pointercancel', cleanup);
    document.body.style.cursor = previousCursor;
    document.body.style.userSelect = previousUserSelect;
    onEnd();
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', cleanup);
  window.addEventListener('pointercancel', cleanup);
  document.body.style.cursor = 'row-resize';
  document.body.style.userSelect = 'none';
  return cleanup;
}
