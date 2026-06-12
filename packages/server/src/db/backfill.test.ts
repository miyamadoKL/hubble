import { describe, it, expect } from 'vitest';
import { openDatabase } from './index';
import { backfillOwners } from './backfill';

describe('backfillOwners', () => {
  it('rewrites empty owners to the technical principal and leaves owned rows alone', () => {
    const db = openDatabase(':memory:');

    // Two legacy rows (empty owner, as if inserted before migration 0002) and one
    // already owned by someone else.
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO notebooks (id, name, description, data, owner, created_at, updated_at)
       VALUES (@id, @name, '', @data, @owner, @t, @t)`,
    ).run({ id: 'nb_legacy1', name: 'L1', data: '{}', owner: '', t: now });
    db.prepare(
      `INSERT INTO notebooks (id, name, description, data, owner, created_at, updated_at)
       VALUES (@id, @name, '', @data, @owner, @t, @t)`,
    ).run({ id: 'nb_owned', name: 'O', data: '{}', owner: 'bob', t: now });
    db.prepare(
      `INSERT INTO saved_queries (id, name, description, statement, is_favorite, owner, created_at, updated_at)
       VALUES (@id, @name, '', 'SELECT 1', 0, '', @t, @t)`,
    ).run({ id: 'sq_legacy', name: 'q', t: now });
    db.prepare(
      `INSERT INTO query_history (id, statement, state, row_count, elapsed_ms, owner, submitted_at)
       VALUES (@id, 'SELECT 1', 'finished', 0, 0, '', @t)`,
    ).run({ id: 'h_legacy', t: now });

    const counts = backfillOwners(db, 'admin');
    expect(counts).toEqual({ notebooks: 1, saved_queries: 1, query_history: 1 });

    const legacy = db.prepare('SELECT owner FROM notebooks WHERE id = ?').get('nb_legacy1') as {
      owner: string;
    };
    expect(legacy.owner).toBe('admin');
    const owned = db.prepare('SELECT owner FROM notebooks WHERE id = ?').get('nb_owned') as {
      owner: string;
    };
    expect(owned.owner).toBe('bob');

    // Idempotent: a second run changes nothing.
    expect(backfillOwners(db, 'admin')).toEqual({
      notebooks: 0,
      saved_queries: 0,
      query_history: 0,
    });
  });
});
