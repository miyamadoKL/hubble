/**
 * CSS クラス名を結合するための小さなユーティリティ関数を定義するファイル。
 * `clsx` や `classnames` のような外部ライブラリを使わず、
 * 依存を増やさない最小実装として自前で用意している。
 */

/**
 * Minimal class-name joiner. Accepts strings, falsy values and is order-stable.
 * Kept dependency-free; Tailwind utility conflicts are avoided by construction
 * (we don't conditionally swap the same property in opposite directions).
 *
 * 最小限のクラス名結合ユーティリティ。文字列と falsy な値（false, null,
 * undefined など）を受け取り、渡された順序を保ったまま結合する。
 * 外部ライブラリに依存しないシンプルな実装で、Tailwind のユーティリティ
 * クラス同士が競合しないよう、そもそも同一プロパティを条件分岐で
 * 逆方向に切り替えるような使い方をしない設計方針にしている。
 */
// cn() の各引数として渡せる値の型。文字列と数値はそのままクラス名として
// 採用され、false / null / undefined は「クラス名なし」として無視される
// （条件付きクラス名の指定を簡潔に書けるようにするため）。
export type ClassValue = string | number | false | null | undefined;

/**
 * 複数のクラス名候補（`ClassValue`）を受け取り、truthy な値だけを
 * 半角スペース区切りで連結した1つの文字列として返す。
 * 例: `cn('a', false, undefined, 'b')` → `"a b"`
 *
 * @param values 結合したいクラス名候補の可変長引数。
 * @returns 結合済みのクラス名文字列（空白区切り）。
 */
export function cn(...values: ClassValue[]): string {
  // Boolean(v) が true となる要素（=空文字列でない文字列、0以外の数値など）
  // のみを残すフィルタリングを行いつつ、型ガードで string | number に絞り込む。
  return values.filter((v): v is string | number => Boolean(v)).join(' ');
}
