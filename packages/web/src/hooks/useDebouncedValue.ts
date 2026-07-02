// --- ファイル概要（日本語） ---
// 値の変化を「デバウンス」する汎用 React hook。頻繁に変化する値（例: 検索入力欄の文字列）を
// そのまま API 呼び出し等のトリガーに使うとキー入力のたびにリクエストが飛んでしまうため、
// 一定時間（delayMs）入力が止まってから初めて値を反映させることで、無駄なリクエストや
// 再計算を抑制する。Saved-queries の検索（design.md §5）で使われている。

import { useEffect, useState } from 'react';

/**
 * Debounce a fast-changing value (design.md §5: 検索 デバウンス 300ms). The
 * returned value trails `value` by `delayMs`; the timer resets on every change,
 * so it only settles once the input goes quiet. Used by the Saved-queries
 * search so each keystroke doesn't fire a request.
 */
/**
 * 頻繁に変化する値をデバウンスする hook（design.md §5: 検索デバウンス 300ms）。
 *
 * @param value - デバウンス対象の値。変化するたびに内部の setTimeout タイマーがリセットされる。
 * @param delayMs - `value` の変化が反映されるまでの遅延（ミリ秒）。デフォルトは300ms。
 * @returns `value` を `delayMs` だけ遅らせて反映した値。入力が連続している間は更新されず、
 *   入力が止まって `delayMs` 経過した時点で最新の `value` に追いつく（＝確定する）。
 *
 * Saved-queries の検索ボックスなどで使われ、キー入力のたびに検索 API を叩くのではなく、
 * ユーザーの入力が一段落してからリクエストを発行するために利用する。
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  // debounced: 実際に外部へ返す「確定済み」の値。value がまだ確定していない間は前回の値を保持する。
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    // value または delayMs が変化するたびにこの effect が再実行される。
    // つまり value が変化するたびに、以前予約したタイマーはクリーンアップ関数で破棄され、
    // 新しいタイマーが delayMs 後に setDebounced を呼ぶよう再セットされる（＝タイマーのリセット）。
    const t = setTimeout(() => setDebounced(value), delayMs);
    // クリーンアップ: 次の effect 実行時（＝value か delayMs が変わったとき）や
    // アンマウント時に、まだ発火していないタイマーを破棄して二重発火を防ぐ。
    return () => clearTimeout(t);
  }, [value, delayMs]);
  // 最新の確定値（value が delayMs 以上変化しなかった場合の値）を返す。
  return debounced;
}
