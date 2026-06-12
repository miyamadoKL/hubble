import { afterEach, describe, expect, it } from 'vitest';
import type { SqlDatabase } from './sqlDatabase';
import { backfillOwners } from './backfill';
import { dbBackends } from '../test/dbBackends';

for (const backend of dbBackends) {
  describe(`backfillOwners on ${backend.name}`, () => {
    let db: SqlDatabase;

    afterEach(async () => {
      if (db) await db.close();
    });

    it('rewrites empty owners to the technical principal and leaves owned rows alone', async () => {
      db = await backend.open();
      const now = new Date().toISOString();

      // Two legacy rows (empty owner, as if inserted before migration 0002) and
      // one already owned by someone else.
      await db.run(
        `INSERT INTO notebooks (id, name, description, data, owner, created_at, updated_at)
         VALUES (?, ?, '', ?, ?, ?, ?)`,
        ['nb_legacy1', 'L1', '{}', '', now, now],
      );
      await db.run(
        `INSERT INTO notebooks (id, name, description, data, owner, created_at, updated_at)
         VALUES (?, ?, '', ?, ?, ?, ?)`,
        ['nb_owned', 'O', '{}', 'bob', now, now],
      );
      await db.run(
        `INSERT INTO saved_queries (id, name, description, statement, is_favorite, owner, created_at, updated_at)
         VALUES (?, ?, '', 'SELECT 1', 0, '', ?, ?)`,
        ['sq_legacy', 'q', now, now],
      );
      await db.run(
        `INSERT INTO query_history (id, statement, state, row_count, elapsed_ms, owner, submitted_at)
         VALUES (?, 'SELECT 1', 'finished', 0, 0, '', ?)`,
        ['h_legacy', now],
      );

      const counts = await backfillOwners(db, 'admin');
      expect(counts).toEqual({ notebooks: 1, saved_queries: 1, query_history: 1 });

      const legacy = await db.query<{ owner: string }>('SELECT owner FROM notebooks WHERE id = ?', [
        'nb_legacy1',
      ]);
      expect(legacy[0]?.owner).toBe('admin');
      const owned = await db.query<{ owner: string }>('SELECT owner FROM notebooks WHERE id = ?', [
        'nb_owned',
      ]);
      expect(owned[0]?.owner).toBe('bob');

      // Idempotent: a second run changes nothing.
      expect(await backfillOwners(db, 'admin')).toEqual({
        notebooks: 0,
        saved_queries: 0,
        query_history: 0,
      });
    });
  });
}
