import type Database from 'better-sqlite3';

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
export function backfillOwners(
  db: Database.Database,
  owner: string,
): Record<string, number> {
  const result: Record<string, number> = {};
  const tx = db.transaction(() => {
    for (const table of OWNED_TABLES) {
      const info = db
        .prepare(`UPDATE ${table} SET owner = @owner WHERE owner = ''`)
        .run({ owner });
      result[table] = info.changes;
    }
  });
  tx();
  return result;
}
