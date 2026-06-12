// `pg` is CommonJS: import the default and destructure so the named exports
// resolve under Node's ESM loader (tsx runtime) as well as the test bundler.
import pg from 'pg';
import type { SqlDatabase, SqlParam } from './sqlDatabase';

const { Pool } = pg;
type PoolClient = pg.PoolClient;
type Pool = pg.Pool;

/** Single-process default; one server process never needs a large pool. */
const POOL_MAX = 5;

/**
 * Rewrite positional `?` placeholders to PostgreSQL's `$1..$n`. Repository SQL
 * never contains a literal `?` inside a string literal (enforced by review),
 * so a straight left-to-right substitution is safe.
 */
export function toPgPlaceholders(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

/**
 * A query executor over either the pool (each call grabs a connection) or a
 * single pinned client (inside a transaction). Shared by both code paths so the
 * `?`→`$n` rewrite and row handling live in one place.
 */
interface PgExecutor {
  query(text: string, values: unknown[]): Promise<{ rows: unknown[] }>;
}

class PostgresDatabase implements SqlDatabase {
  readonly dialect = 'postgres' as const;

  constructor(
    private readonly executor: PgExecutor,
    /** Present on the pool-backed instance; absent on a transaction handle. */
    private readonly pool?: Pool,
  ) {}

  async query<T = Record<string, unknown>>(
    sql: string,
    params: readonly SqlParam[] = [],
  ): Promise<T[]> {
    const res = await this.executor.query(toPgPlaceholders(sql), params as SqlParam[]);
    return res.rows as T[];
  }

  async run(sql: string, params: readonly SqlParam[] = []): Promise<void> {
    await this.executor.query(toPgPlaceholders(sql), params as SqlParam[]);
  }

  async exec(sql: string): Promise<void> {
    // No placeholder rewrite: migration scripts are static DDL with no `?`.
    await this.executor.query(sql, []);
  }

  async transaction<T>(fn: (tx: SqlDatabase) => Promise<T>): Promise<T> {
    if (!this.pool) {
      // Already inside a transaction (nested) — reuse the pinned client.
      return fn(this);
    }
    const client: PoolClient = await this.pool.connect();
    const tx = new PostgresDatabase({
      query: (text, values) => client.query(text, values),
    });
    try {
      await client.query('BEGIN');
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (this.pool) await this.pool.end();
  }

  /**
   * Hold a session-level advisory lock on a single pinned connection while
   * `fn` runs, then release it. Used to serialize concurrent startup
   * migrations. The lock and unlock must share one connection, so this cannot
   * go through the pool-per-call `run`.
   */
  async withAdvisoryLock<T>(key: number, fn: () => Promise<T>): Promise<T> {
    if (!this.pool) throw new Error('withAdvisoryLock requires the pool-backed handle');
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock($1)', [key]);
      try {
        return await fn();
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [key]);
      }
    } finally {
      client.release();
    }
  }
}

/**
 * Open a PostgreSQL-backed SqlDatabase from a connection string. Caller is
 * responsible for running migrations (under an advisory lock).
 */
export function openPostgres(connectionString: string): SqlDatabase {
  const pool = new Pool({ connectionString, max: POOL_MAX });
  return new PostgresDatabase({ query: (text, values) => pool.query(text, values) }, pool);
}
