/**
 * アプリケーション側で発行する各種 ID（クエリ ID、notebook ID など）の生成ユーティリティ。
 *
 * `node:crypto` の `randomUUID` を使い、RFC 4122 UUID v4 を生成する。DB の主キーや
 * API レスポンスに含める識別子として、サーバー内の各リポジトリ/サービスから共通で
 * 利用される。
 */
import { randomUUID } from 'node:crypto';

/**
 * UUID v4 を使った一意 ID を生成する。
 *
 * 引数 `prefix` を指定すると、識別子の種類が一目で分かるように
 * （例: クエリなら `q_...`、notebook なら `nb_...`）先頭へそのまま付与した ID を返す。
 * 省略した場合は UUID のみを返す。
 *
 * @param prefix - ID の種類を表す接頭辞（例: `q_`, `nb_`）。省略可。
 * @returns 生成された ID 文字列。
 */
export function newId(prefix = ''): string {
  // 接頭辞と UUID を連結し、空文字なら UUID だけを返す。
  return `${prefix}${randomUUID()}`;
}
