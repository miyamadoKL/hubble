import { openMemoryDatabase, openDatabase } from '../db';
import type { SqlDatabase } from '../db/sqlDatabase';

/**
 * A persistence backend under test. SQLite always runs; PostgreSQL runs only
 * when `TEST_DATABASE_URL` is set (mirrors the `RUN_TRINO_IT` gating used by
 * realTrino.it.test.ts). This lets the same repository suite exercise both
 * dialects, while keeping a developer's `pnpm test` (no pg) fully green.
 */
export interface DbBackend {
  name: 'sqlite' | 'postgres';
  /** Open a fresh, migrated database, isolated from prior test data. */
  open(): Promise<SqlDatabase>;
}

const TEST_PG_URL = process.env.TEST_DATABASE_URL;

/** All tables a repository test may touch; truncated between pg test cases. */
const OWNED_TABLES = ['notebooks', 'saved_queries', 'query_history'] as const;

const sqliteBackend: DbBackend = {
  name: 'sqlite',
  // A fresh in-memory database per test gives natural isolation.
  open: () => openMemoryDatabase(),
};

const postgresBackend: DbBackend | undefined = TEST_PG_URL
  ? {
      name: 'postgres',
      async open() {
        const db = await openDatabase({ kind: 'postgres', url: TEST_PG_URL });
        // Isolate each test: a shared pg database persists across cases, so wipe
        // the user tables (migrations / schema_migrations stay intact).
        await db.run(`TRUNCATE ${OWNED_TABLES.join(', ')}`);
        return db;
      },
    }
  : undefined;

/**
 * The backends to parameterize a repository suite over. SQLite is always
 * present; PostgreSQL is appended only when `TEST_DATABASE_URL` is set.
 */
export const dbBackends: DbBackend[] = postgresBackend
  ? [sqliteBackend, postgresBackend]
  : [sqliteBackend];

/** True when the pg-gated suites should run (TEST_DATABASE_URL is set). */
export const pgEnabled = postgresBackend !== undefined;
