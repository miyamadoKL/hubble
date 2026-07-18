/**
 * resultHeight.ts
 *
 * セルごとの結果表示域（ResultGrid の仮想化スクロールコンテナ）の高さを扱う
 * ヘルパー群。ノートブック単位で1つの localStorage キーに `{ セルID: px数値 }`
 * の JSON を保存し、セルを一度もドラッグ調整していない間は明示的な高さを持たない
 * （呼び出し側が Tailwind の `max-h-96` にフォールバックする）。クランプ計算と
 * JSON の読み書きを純粋関数として切り出し、DOM描画なしに単体テストできるようにしている。
 * pointer ドラッグの配線自体（`beginResultHeightResize`）は結果表示域固有のロジックを
 * 含まないため、SQL エディターの高さハンドル（editorHeight.ts）と共有できるよう
 * verticalDragResize.ts の汎用実装をそのまま re-export している。
 */
import { principalStorageKey } from '../storage/principalStorage';
import { beginVerticalDragResize } from './verticalDragResize';

/** 結果表示域の高さの下限（px）。 */
export const RESULT_HEIGHT_MIN = 128;
/** 結果表示域の高さの上限を計算する際のビューポート高さに対する割合。 */
export const RESULT_HEIGHT_MAX_VH_RATIO = 0.8;

/** セルID をキーとした高さ（px）のマップ。 */
export type ResultHeightsMap = Record<string, number>;

/** ノートブックごとの永続化キーを組み立てる（principal ごとに namespace される）。 */
export function resultHeightsStorageKey(notebookId: string): string {
  return principalStorageKey(`hubble.ui.resultHeights.${notebookId}`);
}

/**
 * 現在のビューポート高さから実際に許容される高さの上限（px）を求める。
 * ビューポート高さの80%相当だが、下限（RESULT_HEIGHT_MIN）を下回らない。
 * clampResultHeight と、ハンドルの aria-valuemax 表示（ResultGrid 側）の
 * 両方から同じ計算を共有するために切り出している。
 */
export function resultHeightMax(viewportHeight: number): number {
  return Math.max(RESULT_HEIGHT_MIN, Math.round(viewportHeight * RESULT_HEIGHT_MAX_VH_RATIO));
}

/**
 * 指定した高さを許容範囲へクランプする。下限は常に RESULT_HEIGHT_MIN、上限は
 * ビューポート高さの80%相当（ただし下限を下回らない）。
 */
export function clampResultHeight(height: number, viewportHeight: number): number {
  const max = resultHeightMax(viewportHeight);
  return Math.min(max, Math.max(RESULT_HEIGHT_MIN, Math.round(height)));
}

/**
 * localStorage から読み出した生の JSON 文字列を ResultHeightsMap へパースする。
 * 壊れた JSON、オブジェクトでない値、数値でないエントリはすべて無視する
 * （例外を投げず、それらを除いた安全なマップを返す）。
 */
export function parseResultHeights(raw: string | null): ResultHeightsMap {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const result: ResultHeightsMap = {};
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
export function pruneResultHeights(
  heights: ResultHeightsMap,
  validCellIds: ReadonlySet<string>,
): ResultHeightsMap {
  const result: ResultHeightsMap = {};
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
export function readResultHeightsMap(notebookId: string): ResultHeightsMap {
  try {
    return parseResultHeights(
      safeLocalStorage()?.getItem(resultHeightsStorageKey(notebookId)) ?? null,
    );
  } catch {
    // プライベートブラウジング等でgetItem自体が例外を投げる環境向けフォールバック。
    return {};
  }
}

/** ノートブック全体の高さマップを書き込む（quota 超過等は無視して非致命的に扱う）。 */
function writeResultHeightsMap(notebookId: string, heights: ResultHeightsMap): void {
  try {
    safeLocalStorage()?.setItem(resultHeightsStorageKey(notebookId), JSON.stringify(heights));
  } catch {
    /* quota 超過やsetItem自体の例外等（致命的ではないため無視する） */
  }
}

/**
 * 指定セルの明示的な高さを読み出す。現在存在するセルID（= 呼び出し元がまさに
 * 描画しようとしているセル自身）だけを対象に pruneResultHeights を適用するため、
 * 削除済みセルの古いエントリを誤って使うことはない。未調整、または壊れたエントリの
 * 場合は null を返す。
 */
export function getResultHeight(notebookId: string, cellId: string): number | null {
  const map = readResultHeightsMap(notebookId);
  const pruned = pruneResultHeights(map, new Set([cellId]));
  return pruned[cellId] ?? null;
}

/** 指定セルの明示的な高さを保存する（同じノートブックの他セルのエントリは保持する）。 */
export function setResultHeight(notebookId: string, cellId: string, height: number): void {
  const map = readResultHeightsMap(notebookId);
  map[cellId] = Math.round(height);
  writeResultHeightsMap(notebookId, map);
}

/** 指定セルの明示的な高さを解除する（未調整状態＝内容依存の自動サイズへ戻す）。 */
export function resetResultHeight(notebookId: string, cellId: string): void {
  const map = readResultHeightsMap(notebookId);
  if (!(cellId in map)) return;
  delete map[cellId];
  writeResultHeightsMap(notebookId, map);
}

/**
 * 高さリサイズハンドルの pointer ドラッグを開始する（結果表示域向けの名前を保った
 * re-export）。実装本体は verticalDragResize.ts を参照。
 */
export const beginResultHeightResize = beginVerticalDragResize;
