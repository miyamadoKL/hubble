/**
 * アプリケーション側で発行する各種 ID（クエリ ID、notebook ID など）の生成ユーティリティ。
 *
 * `nanoid` の `customAlphabet` を使い、URL に含めても安全な文字集合のみで
 * 衝突耐性の高い短い ID を生成する。DB の主キーや API レスポンスに含める
 * 識別子として、サーバー内の各リポジトリ/サービスから共通で利用される。
 */
import { customAlphabet } from 'nanoid';

// URL-safe, collision-resistant ids for application-assigned query ids etc.
// 日本語: URL エンコード不要な英数字のみのアルファベット（記号や紛らわしい文字を含まない）。
// この文字集合と長さ 21 文字の組み合わせにより、実用上十分な衝突耐性を確保する。
const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
// 日本語: 上記アルファベットから 21 文字のランダム ID を生成する関数を事前に構築しておく
// （呼び出しごとに再構築せず使い回すことで生成コストを抑える）。
const generate = customAlphabet(alphabet, 21);

/**
 * 短い一意 ID を生成する。
 *
 * 日本語: 引数 `prefix` を指定すると、識別子の種類が一目で分かるように
 * （例: クエリなら `q_...`、notebook なら `nb_...`）先頭に付与した ID を返す。
 * 省略した場合はプレフィックスなしのランダム文字列のみを返す。
 *
 * @param prefix - ID の種類を表す接頭辞（例: `q_`, `nb_`）。省略可。
 * @returns 生成された ID 文字列。
 */
export function newId(prefix = ''): string {
  // prefix が空文字（デフォルト）の場合は連結せずそのまま返す。
  return prefix ? `${prefix}${generate()}` : generate();
}
