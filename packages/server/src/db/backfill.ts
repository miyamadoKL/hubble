import type { SqlDatabase } from './sqlDatabase';

const OWNED_TABLES = ['notebooks', 'saved_queries', 'query_history'] as const;

/**
 * Backfill empty `owner` columns with the configured principal (design.md §11).
 *
 * Migration `0002` adds `owner TEXT NOT NULL DEFAULT ''` because static SQL
 * cannot read the runtime `TRINO_USER`. At startup we rewrite those empty
 * owners to the technical principal so pre-existing notebooks / saved queries /
 * history become owned by it (the `none`-mode owner). Idempotent: rows already
 * owned are left untouched. Returns the number of rows updated per table.
 */
export async function backfillOwners(
  db: SqlDatabase,
  owner: string,
): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  await db.transaction(async (tx) => {
    for (const table of OWNED_TABLES) {
      // RETURNING is supported by both SQLite (3.35+) and PostgreSQL, giving a
      // dialect-neutral way to count affected rows.
      const updated = await tx.query<{ id: string }>(
        `UPDATE ${table} SET owner = ? WHERE owner = '' RETURNING id`,
        [owner],
      );
      result[table] = updated.length;
    }
  });
  return result;
}
