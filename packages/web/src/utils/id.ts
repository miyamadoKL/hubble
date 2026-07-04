/**
 * クライアント側で一意な ID を生成するユーティリティを定義するファイル。
 * セルやドラフトノートブックなど、サーバーに保存する前の一時的なオブジェクトに
 * 対して安定したキーを割り当てるために使用する。
 */

// Stable client-side ids for cells and draft notebooks (cellId is
// a stable key). `crypto.randomUUID` is available in every target browser and in
// jsdom (Node ≥ 19), so no extra dependency is needed.
// セルやドラフトノートブックのための、クライアント側で安定した ID
// （cellId は安定したキーであること、という要件に対応）。
// `crypto.randomUUID` は対象とするすべてのブラウザ、および jsdom（Node ≥ 19）
// でも利用可能な標準 API なので、外部の UUID 生成ライブラリへの依存を追加する
// 必要がない。

/** A stable unique id, optionally namespaced with a short prefix. */
/**
 * 一意で安定した ID 文字列を生成する。
 * `crypto.randomUUID()` によりランダムな UUID（v4）を生成し、
 * 任意で短い接頭辞（namespace）を付与できる。
 * 接頭辞を指定した場合は `"{prefix}-{uuid}"` の形式、
 * 指定しない場合は UUID のみを返す。
 *
 * @param prefix ID に付与する接頭辞（省略時は接頭辞なし）。
 * @returns 生成された一意な ID 文字列。
 */
export function uid(prefix = ''): string {
  const id = crypto.randomUUID();
  return prefix ? `${prefix}-${id}` : id;
}
