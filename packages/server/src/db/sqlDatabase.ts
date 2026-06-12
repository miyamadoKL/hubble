/**
 * Minimal async SQL abstraction shared by the SQLite and PostgreSQL backends
 * (design.md §4, backend selection via DATABASE_URL / DB_PATH).
 *
 * All repository SQL is written with positional `?` placeholders and a flat
 * params array. The PostgreSQL adapter rewrites `?` to `$1..$n`; the SQLite
 * adapter passes them through to better-sqlite3 unchanged. Keep SQL free of
 * literal `?` characters inside string literals so the rewrite stays correct.
 */
export type SqlDialect = 'sqlite' | 'postgres';

/** A bound parameter value. JSON payloads are passed as strings (TEXT columns). */
export type SqlParam = string | number | boolean | null;

export interface SqlDatabase {
  readonly dialect: SqlDialect;

  /** Run a query returning rows. `T` is the row shape (snake_case columns). */
  query<T = Record<string, unknown>>(sql: string, params?: readonly SqlParam[]): Promise<T[]>;

  /** Run a single statement for its side effects (INSERT / UPDATE / DELETE). */
  run(sql: string, params?: readonly SqlParam[]): Promise<void>;

  /**
   * Execute a multi-statement SQL script (no parameters), e.g. a migration
   * file. SQLite runs the whole string; PostgreSQL runs it as one simple-query
   * batch. Use `run` for single parameterized statements.
   */
  exec(sql: string): Promise<void>;

  /**
   * Run `fn` inside a single transaction. The callback receives a database
   * handle bound to the transaction; statements issued through it are atomic.
   * Rolls back if `fn` throws.
   */
  transaction<T>(fn: (tx: SqlDatabase) => Promise<T>): Promise<T>;

  /** Close the underlying connection / pool. */
  close(): Promise<void>;
}
