/**
 * PostgreSQL 向けの `SqlDatabase` アダプター実装。
 *
 * `pg` パッケージの接続プールをラップし、`SqlDatabase` インターフェースが
 * 要求する `query` / `run` / `exec` / `transaction` / `close` を提供する。
 * リポジトリ層は SQLite 用に書かれた `?` プレースホルダを使うため、このモジュール
 * では `toPgPlaceholders()` で `$1..$n` 形式へ変換してから発行する。加えて、
 * マイグレーション適用を複数プロセス間で直列化するための PostgreSQL 固有の
 * advisory lock（`withAdvisoryLock`）もここで実装する（SQLite アダプターには
 * 存在しない、PostgreSQL 固有の拡張）。
 */
// `pg` is CommonJS: import the default and destructure so the named exports
// resolve under Node's ESM loader (tsx runtime) as well as the test bundler.
// `pg` は CommonJS パッケージのため、default export をいったん受けてから
// 分割代入する。こうすることで Node の ESM ローダー（tsx ランタイム）でも
// テストバンドラーでも named export として解決できるようにしている。
import pg from 'pg';
import type { SqlDatabase, SqlParam } from './sqlDatabase';

const { Pool } = pg;
type PoolClient = pg.PoolClient;
type Pool = pg.Pool;

/** Single-process default; one server process never needs a large pool. */
// 1サーバープロセスあたりのコネクションプール上限。Hubble は単一プロセスの
// サーバーであり大きなプールを必要としないため、控えめな値にしている。
const POOL_MAX = 5;

/**
 * Rewrite positional `?` placeholders to PostgreSQL's `$1..$n`. Repository SQL
 * never contains a literal `?` inside a string literal (enforced by review),
 * so a straight left-to-right substitution is safe.
 *
 * SQLite 方言の位置プレースホルダ `?` を PostgreSQL の `$1..$n` 形式へ書き
 * 換える。リポジトリ層の SQL 文字列リテラル中には `?` が現れない前提（コード
 * レビューで担保）なので、出現順に単純に `$1`, `$2`, ... と振っていくだけで
 * 安全に変換できる。
 */
export function toPgPlaceholders(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

/**
 * A query executor over either the pool (each call grabs a connection) or a
 * single pinned client (inside a transaction). Shared by both code paths so the
 * `?`→`$n` rewrite and row handling live in one place.
 *
 * クエリ実行の抽象。プール経由（呼び出しごとにコネクションを取得して返却）と、
 * トランザクション中に固定された単一クライアント経由のどちらの場合も同じ
 * インターフェースで扱えるようにし、`?`→`$n` の変換や行の取り扱いを1箇所に
 * まとめている。
 */
interface PgExecutor {
  query(text: string, values: unknown[]): Promise<{ rows: unknown[] }>;
}

// PostgreSQL 用の SqlDatabase 実装本体。プールに直結したインスタンス（トップ
// レベル）と、トランザクション中に1つのクライアントへピン留めされたインス
// タンス（transaction() 内で生成）の2種類の使われ方をする。
class PostgresDatabase implements SqlDatabase {
  readonly dialect = 'postgres' as const;

  constructor(
    private readonly executor: PgExecutor,
    /** Present on the pool-backed instance; absent on a transaction handle. */
    // pool はプール直結インスタンスにのみ存在し、トランザクションハンドル
    // （子インスタンス）には存在しない。これにより「自分がトップレベルの
    // ハンドルかどうか」を判定できる。
    private readonly pool?: Pool,
  ) {}

  async query<T = Record<string, unknown>>(
    sql: string,
    params: readonly SqlParam[] = [],
  ): Promise<T[]> {
    // ? → $n に変換してから実行し、結果行をそのまま T[] として返す。
    const res = await this.executor.query(toPgPlaceholders(sql), params as SqlParam[]);
    return res.rows as T[];
  }

  async run(sql: string, params: readonly SqlParam[] = []): Promise<void> {
    // query() と同じ実行経路を使うが、戻り値の行は呼び出し側に返さない。
    await this.executor.query(toPgPlaceholders(sql), params as SqlParam[]);
  }

  async exec(sql: string): Promise<void> {
    // No placeholder rewrite: migration scripts are static DDL with no `?`.
    // プレースホルダの変換は行わない。マイグレーションスクリプトはパラメータ
    // を持たない静的な DDL であり `?` を含まない前提のため。
    await this.executor.query(sql, []);
  }

  async transaction<T>(fn: (tx: SqlDatabase) => Promise<T>): Promise<T> {
    if (!this.pool) {
      // Already inside a transaction (nested) — reuse the pinned client.
      // 既にトランザクション中（ネストした呼び出し）の場合は、新たに
      // BEGIN/COMMIT せず自分自身（同じピン留めクライアント）をそのまま
      // 使い回す。PostgreSQL はネストしたトランザクションを直接サポート
      // しないため、この実装では外側のトランザクションに同居させる形になる。
      return fn(this);
    }
    // プールから1本コネクションを借り、そのコネクションに固定した新しい
    // PostgresDatabase インスタンス（tx）を作る。以降 tx を通じて発行される
    // クエリは全てこの1本のコネクション上で実行され、BEGIN/COMMIT/ROLLBACK
    // と整合する。
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
      // fn の実行中に例外が発生したらロールバックしてから再送出する。
      await client.query('ROLLBACK');
      throw err;
    } finally {
      // 成功でも失敗でもコネクションは必ずプールへ返却する。
      client.release();
    }
  }

  async close(): Promise<void> {
    // トランザクション用の子インスタンスは pool を持たないため何もしない。
    // プール直結インスタンスのみプール全体を終了させる。
    if (this.pool) await this.pool.end();
  }

  /**
   * Hold a session-level advisory lock on a single pinned connection while
   * `fn` runs, then release it. Used to serialize concurrent startup
   * migrations. The lock and unlock must share one connection, so this cannot
   * go through the pool-per-call `run`.
   *
   * `fn` の実行中、1本のコネクションに固定したままセッションレベルの
   * advisory lock を保持し続け、実行後に解放する。複数プロセスが同時に
   * 起動してマイグレーションを実行しようとしたときに、その適用処理を
   * 直列化するために使う。ロックの取得と解放は同一コネクション上で行う
   * 必要があるため、呼び出しごとにコネクションが変わり得るプール経由の
   * `run` では実現できず、専用のコネクションを1本借りて使い回す。
   */
  async withAdvisoryLock<T>(key: number, fn: () => Promise<T>): Promise<T> {
    if (!this.pool) throw new Error('withAdvisoryLock requires the pool-backed handle');
    const client = await this.pool.connect();
    try {
      // セッション単位の advisory lock を取得。他プロセスが同じ key で
      // ロックを取ろうとしている場合、ここで解放されるまでブロックされる。
      await client.query('SELECT pg_advisory_lock($1)', [key]);
      try {
        return await fn();
      } finally {
        // fn の成否に関わらずロックは必ず解放する。
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
 *
 * 接続文字列から PostgreSQL 版の `SqlDatabase` を開く。コネクションプールを
 * 生成し、プールに直結した `PostgresDatabase` インスタンスを返す。呼び出し
 * 側（db/index.ts の `openDatabase`）が、advisory lock 下でのマイグレーション
 * 実行を責務として持つ。
 */
export function openPostgres(connectionString: string): SqlDatabase {
  const pool = new Pool({ connectionString, max: POOL_MAX });
  return new PostgresDatabase({ query: (text, values) => pool.query(text, values) }, pool);
}
