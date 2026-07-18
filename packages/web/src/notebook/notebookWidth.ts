/**
 * notebookWidth.ts
 *
 * ノートブック列幅（NotebookView の中央カラムの最大幅）を扱うヘルパー群。
 * 特定のノートブックではなく全ノートブックに共通するUI設定として、
 * principal storage の localStorage キーへ数値pxを保存する。クランプ計算と
 * pointer ドラッグの配線を純粋関数として切り出すことで、DOM描画なしに
 * 単体テストできるようにしている。
 */
import { principalStorageKey } from '../storage/principalStorage';

/** ノートブック幅の下限（px）。Tailwind の max-w-2xl 相当。 */
export const NOTEBOOK_WIDTH_MIN = 672;
/** ノートブック幅の上限の絶対値（px）。ビューポート幅からの制約とはさらに min を取る。 */
export const NOTEBOOK_WIDTH_ABSOLUTE_MAX = 1600;
/** 上限計算時にビューポート端から確保する余白（px）。 */
export const NOTEBOOK_WIDTH_VIEWPORT_MARGIN = 32;
/** 既定のノートブック幅（px）。ハンドルのダブルクリックでこの値に戻る。 */
export const NOTEBOOK_WIDTH_DEFAULT = 896;

/** localStorage に保存する際のキー。principal（認証主体）ごとに namespace される。 */
export const NOTEBOOK_WIDTH_STORAGE_KEY = principalStorageKey('hubble.ui.notebookWidth');

/**
 * 現在のビューポート幅から実際に許容される幅の上限（px）を求める。
 * `min(NOTEBOOK_WIDTH_ABSOLUTE_MAX, viewportWidth - margin)` だが、ビューポートが
 * 極端に狭い場合でも NOTEBOOK_WIDTH_MIN を下回らない。clampNotebookWidth と、
 * ハンドルの aria-valuemax 表示（NotebookView 側）の両方から同じ計算を共有するために
 * 切り出している。
 */
export function notebookWidthMax(viewportWidth: number): number {
  const viewportMax = viewportWidth - NOTEBOOK_WIDTH_VIEWPORT_MARGIN;
  return Math.max(NOTEBOOK_WIDTH_MIN, Math.min(NOTEBOOK_WIDTH_ABSOLUTE_MAX, viewportMax));
}

/**
 * 指定した幅を許容範囲へクランプする。上限は `min(NOTEBOOK_WIDTH_ABSOLUTE_MAX,
 * viewportWidth - margin)`、下限は常に NOTEBOOK_WIDTH_MIN。ビューポートが極端に
 * 狭く上限が下限を下回る場合でも、最終的な戻り値は必ず NOTEBOOK_WIDTH_MIN 以上になる。
 */
export function clampNotebookWidth(width: number, viewportWidth: number): number {
  const max = notebookWidthMax(viewportWidth);
  return Math.min(max, Math.max(NOTEBOOK_WIDTH_MIN, Math.round(width)));
}

// SSR やプライベートブラウジング等で localStorage が使えない環境でも
// 例外で落ちないようにするためのガード付きアクセサ。
// 取得したStorageオブジェクトへのgetItem/setItem呼び出し自体が例外を投げる
// ブラウザ（プライベートブラウジング時のSafari等）もあるため、呼び出し側は
// このオブジェクトの取得だけでなく実際のgetItem/setItem呼び出しもtryで
// 囲むこと（このアクセサ単体では読み書き時の例外はガードできない）。
function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/**
 * 保存済みのノートブック幅を読み出す（クランプ前の生の値）。未保存または壊れた値の場合は
 * 既定値を返す。呼び出し側でビューポート幅に応じたクランプを行うこと。
 */
export function readNotebookWidth(): number {
  try {
    const raw = safeLocalStorage()?.getItem(NOTEBOOK_WIDTH_STORAGE_KEY);
    if (!raw) return NOTEBOOK_WIDTH_DEFAULT;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : NOTEBOOK_WIDTH_DEFAULT;
  } catch {
    // プライベートブラウジング等でgetItem自体が例外を投げる環境向けフォールバック。
    return NOTEBOOK_WIDTH_DEFAULT;
  }
}

/** ノートブック幅を localStorage へ保存する（quota 超過等は無視して非致命的に扱う）。 */
export function writeNotebookWidth(width: number): void {
  try {
    safeLocalStorage()?.setItem(NOTEBOOK_WIDTH_STORAGE_KEY, String(Math.round(width)));
  } catch {
    /* quota 超過やsetItem自体の例外等（致命的ではないため無視する） */
  }
}

/**
 * 幅リサイズハンドルの pointer ドラッグを開始する。`edge` が 'right' ならポインタが
 * 右へ動いた分の2倍、'left' なら左へ動いた分の2倍を幅の増分として `setWidth` に渡す。
 * これにより、どちらのハンドルをドラッグしても `mx-auto` の中央寄せを保ったまま
 * 左右対称に幅が広がる見た目になる。呼び出し元は pointerup 時（または unmount 時）に
 * 返り値の cleanup を呼ぶこと。
 *
 * `pointerId` はドラッグ開始時のポインタを特定するための識別子（React の
 * PointerEvent#pointerId をそのまま渡す想定）。マルチタッチ等で無関係な
 * pointermove/pointerup/pointercancel が飛んできても無視するために使う。
 * また `pointerup` だけでなく `pointercancel`（タッチスクロールへの切替や
 * ジェスチャー中断で発火する）でも同じ cleanup を呼び、window の event listener と
 * document.body.style の変更が unmount までリークしないようにする。
 */
export function beginNotebookWidthResize(
  edge: 'left' | 'right',
  startX: number,
  startWidth: number,
  setWidth: (width: number) => void,
  onEnd: () => void = () => {},
  pointerId?: number,
): () => void {
  const previousCursor = document.body.style.cursor;
  const previousUserSelect = document.body.style.userSelect;
  const sign = edge === 'right' ? 1 : -1;
  let active = true;
  const onMove = (event: PointerEvent) => {
    if (active && event.pointerId === pointerId) {
      setWidth(startWidth + sign * (event.clientX - startX) * 2);
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
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  return cleanup;
}
