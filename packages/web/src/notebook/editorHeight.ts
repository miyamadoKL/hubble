/**
 * editorHeight.ts
 *
 * セルごとの SQL エディター（SqlEditor / Monaco ホスト要素）の高さを扱う
 * ヘルパー群。resultHeight.ts（結果表示域の高さ）と全く同じ設計を踏襲する:
 * ノートブック単位で1つの localStorage キーに `{ セルID: px数値 }` の JSON を
 * 保存し、セルを一度もドラッグ調整していない間は明示的な高さを持たない
 * （呼び出し側が内容量に応じた自動伸縮 [4〜40行] にフォールバックする）。
 * クランプ計算と JSON の読み書きを純粋関数として切り出し、DOM描画なしに
 * 単体テストできるようにしている。pointer ドラッグの配線は resultHeight.ts と
 * 共通の verticalDragResize.ts を再利用する。
 */
import { principalStorageKey } from '../storage/principalStorage';
import { beginVerticalDragResize } from './verticalDragResize';

/** Monaco の1行あたりの高さ（px）。SqlEditor の行高設定と一致させること。 */
export const EDITOR_LINE_HEIGHT = 20;
/** 自動伸縮時/手動オーバーライド時ともに共通する最小行数。 */
export const EDITOR_MIN_LINES = 4;
/** 自動伸縮（内容連動）時の最大行数。SqlEditor の MAX_LINES と一致させること。 */
export const EDITOR_MAX_LINES = 40;
/** エディター上下の padding（px）。SqlEditor の `padding: { top, bottom }` と一致させること。 */
export const EDITOR_VERTICAL_PADDING = 16;
/** 手動オーバーライドの高さの下限（px）。4行相当。 */
export const EDITOR_HEIGHT_MIN = EDITOR_MIN_LINES * EDITOR_LINE_HEIGHT + EDITOR_VERTICAL_PADDING;
/** 手動オーバーライドの高さの上限を計算する際のビューポート高さに対する割合。 */
export const EDITOR_HEIGHT_MAX_VH_RATIO = 0.8;
/**
 * 自動伸縮（内容連動）が行数だけから決まる、ビューポートを考慮しない生の上限高さ（px）。
 * 40行相当。SqlEditor 側はこの値をそのまま使わず、必ず editorHeightMax(viewportHeight)
 * ともう一段 min() を取ってから描画に使う（自動伸縮の高さが手動オーバーライドの
 * 許容レンジ [EDITOR_HEIGHT_MIN, editorHeightMax(viewport)] を超えないようにするため）。
 * これを怠ると、80vhが40行分の高さ（816px）を下回る低いビューポートで、自動伸縮中の
 * 高さが手動レンジの外に出てしまい、矢印キー1回や移動量ゼロのドラッグで手動調整に
 * 切り替えた瞬間に大きくジャンプする（例: 768px高の画面では80vh=614pxなので、
 * クランプなしだと816→614へ一気に縮む）。
 */
export const EDITOR_AUTO_HEIGHT_MAX =
  EDITOR_MAX_LINES * EDITOR_LINE_HEIGHT + EDITOR_VERTICAL_PADDING;

/** セルID をキーとした高さ（px）のマップ。 */
export type EditorHeightsMap = Record<string, number>;

/** ノートブックごとの永続化キーを組み立てる（principal ごとに namespace される）。 */
export function editorHeightsStorageKey(notebookId: string): string {
  return principalStorageKey(`hubble.ui.editorHeights.${notebookId}`);
}

/**
 * 現在のビューポート高さから実際に許容される高さの上限（px）を求める。
 * 手動オーバーライドの仕様どおり「ビューポート高さの80%相当」だが、下限
 * （EDITOR_HEIGHT_MIN）を下回らない。この上限は自動伸縮の高さにも適用される
 * （SqlEditor 側で、行数だけから決まる EDITOR_AUTO_HEIGHT_MAX とこの値の
 * 小さい方を実際の描画高さに使う）ため、自動伸縮中の高さが常にこの手動レンジ内に
 * 収まる。clampEditorHeight と、ハンドルの aria-valuemax 表示（SqlEditor 側）の
 * 両方から同じ計算を共有するために切り出している。
 */
export function editorHeightMax(viewportHeight: number): number {
  return Math.max(EDITOR_HEIGHT_MIN, Math.round(viewportHeight * EDITOR_HEIGHT_MAX_VH_RATIO));
}

/**
 * 指定した高さを許容範囲へクランプする。下限は常に EDITOR_HEIGHT_MIN（4行相当）、
 * 上限はビューポート高さの80%相当（ただし下限を下回らない）。
 */
export function clampEditorHeight(height: number, viewportHeight: number): number {
  const max = editorHeightMax(viewportHeight);
  return Math.min(max, Math.max(EDITOR_HEIGHT_MIN, Math.round(height)));
}

/**
 * localStorage から読み出した生の JSON 文字列を EditorHeightsMap へパースする。
 * 壊れた JSON、オブジェクトでない値、数値でないエントリはすべて無視する
 * （例外を投げず、それらを除いた安全なマップを返す）。
 */
export function parseEditorHeights(raw: string | null): EditorHeightsMap {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const result: EditorHeightsMap = {};
    for (const [cellId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) result[cellId] = value;
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * 現在ノートブックに存在するセルIDのエントリだけを残す。削除済みセルの
 * 古いエントリはここで自然に捨てられる（読み込み側が使わなくなるだけで、
 * ストレージ上の物理的な削除は行わない）。
 */
export function pruneEditorHeights(
  heights: EditorHeightsMap,
  validCellIds: ReadonlySet<string>,
): EditorHeightsMap {
  const result: EditorHeightsMap = {};
  for (const [cellId, value] of Object.entries(heights)) {
    if (validCellIds.has(cellId)) result[cellId] = value;
  }
  return result;
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

/** ノートブック全体の高さマップを読み出す（壊れたエントリは除外済み）。 */
export function readEditorHeightsMap(notebookId: string): EditorHeightsMap {
  try {
    return parseEditorHeights(
      safeLocalStorage()?.getItem(editorHeightsStorageKey(notebookId)) ?? null,
    );
  } catch {
    // プライベートブラウジング等でgetItem自体が例外を投げる環境向けフォールバック。
    return {};
  }
}

/** ノートブック全体の高さマップを書き込む（quota 超過等は無視して非致命的に扱う）。 */
function writeEditorHeightsMap(notebookId: string, heights: EditorHeightsMap): void {
  try {
    safeLocalStorage()?.setItem(editorHeightsStorageKey(notebookId), JSON.stringify(heights));
  } catch {
    /* quota 超過やsetItem自体の例外等（致命的ではないため無視する） */
  }
}

/**
 * 指定セルの明示的な高さを読み出す。現在存在するセルID（= 呼び出し元がまさに
 * 描画しようとしているセル自身）だけを対象に pruneEditorHeights を適用するため、
 * 削除済みセルの古いエントリを誤って使うことはない。未調整、または壊れたエントリの
 * 場合は null を返す。
 */
export function getEditorHeight(notebookId: string, cellId: string): number | null {
  const map = readEditorHeightsMap(notebookId);
  const pruned = pruneEditorHeights(map, new Set([cellId]));
  return pruned[cellId] ?? null;
}

/** 指定セルの明示的な高さを保存する（同じノートブックの他セルのエントリは保持する）。 */
export function setEditorHeight(notebookId: string, cellId: string, height: number): void {
  const map = readEditorHeightsMap(notebookId);
  map[cellId] = Math.round(height);
  writeEditorHeightsMap(notebookId, map);
}

/** 指定セルの明示的な高さを解除する（未調整状態＝内容依存の自動サイズへ戻す）。 */
export function resetEditorHeight(notebookId: string, cellId: string): void {
  const map = readEditorHeightsMap(notebookId);
  if (!(cellId in map)) return;
  delete map[cellId];
  writeEditorHeightsMap(notebookId, map);
}

/**
 * 高さリサイズハンドルの pointer ドラッグを開始する（エディター向けの名前を保った
 * re-export）。実装本体は verticalDragResize.ts を参照。
 */
export const beginEditorHeightResize = beginVerticalDragResize;
