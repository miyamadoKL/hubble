/**
 * 起動時に一度だけ実行される「owner バックフィル」処理。
 *
 * migration `0002` で `notebooks` / `saved_queries` / `query_history` に
 * `owner TEXT NOT NULL DEFAULT ''` 列を追加した際、静的な SQL からは実行時の
 * `TRINO_USER`（技術プリンシパル）を参照できないため、まず空文字 `''` を
 * デフォルト値として入れておき、サーバー起動時にこのファイルの
 * `backfillOwners()` で空の owner を実際のプリンシパルへ書き換える。
 * 既に owner が設定されている行には触れない（冪等）ため、何度呼び出しても
 * 安全。
 */
import type { SqlDatabase } from './sqlDatabase';

// バックフィル対象となるテーブル一覧。owner 列を持つ全テーブルをここに列挙する。
const OWNED_TABLES = ['notebooks', 'saved_queries', 'query_history'] as const;

/**
 * Backfill empty `owner` columns with the configured principal (design.md §11).
 *
 * Migration `0002` adds `owner TEXT NOT NULL DEFAULT ''` because static SQL
 * cannot read the runtime `TRINO_USER`. At startup we rewrite those empty
 * owners to the technical principal so pre-existing notebooks / saved queries /
 * history become owned by it (the `none`-mode owner). Idempotent: rows already
 * owned are left untouched. Returns the number of rows updated per table.
 *
 * 空の `owner` 列を、設定済みのプリンシパルで埋め戻す（design.md §11）。
 *
 * migration `0002` は `owner TEXT NOT NULL DEFAULT ''` を追加するが、静的な
 * SQL 側では実行時の `TRINO_USER` を読み取れないため、この関数をサーバー
 * 起動時に呼び出し、空の owner を技術プリンシパル（`none` モードの owner）へ
 * 書き換える。これにより、認証モード導入前から存在していたノートブック／
 * 保存済みクエリ／実行履歴がその技術プリンシパルの所有物になる。既に owner
 * が入っている行はそのまま残るため、何度実行しても結果は変わらない
 * （冪等性）。戻り値はテーブルごとに更新した行数。
 */
export async function backfillOwners(
  db: SqlDatabase,
  owner: string,
): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  // 全テーブルの更新をひとつのトランザクションにまとめ、途中で失敗した場合は
  // 全体をロールバックして中途半端な状態を避ける。
  await db.transaction(async (tx) => {
    for (const table of OWNED_TABLES) {
      // RETURNING is supported by both SQLite (3.35+) and PostgreSQL, giving a
      // dialect-neutral way to count affected rows.
      // RETURNING 句は SQLite（3.35 以降）と PostgreSQL の両方でサポートされて
      // いるため、方言に依存せず「何件更新されたか」を取得できる。ここでは
      // 更新された行の id 一覧を受け取り、その配列長を件数として使う。
      const updated = await tx.query<{ id: string }>(
        `UPDATE ${table} SET owner = ? WHERE owner = '' RETURNING id`,
        [owner],
      );
      result[table] = updated.length;
    }
  });
  return result;
}
