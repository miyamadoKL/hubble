/**
 * PostgreSQL 向けの `SqlDatabase` アダプター実装。
 *
 * `pg` パッケージの接続プールをラップし、`SqlDatabase` インターフェースが
 * 要求する `query` / `run` / `exec` / `transaction` / `close` を提供する。
 * リポジトリ層の SQL は PostgreSQL の `$1..$n` 形式で記述し、そのまま発行する。加えて、
 * マイグレーション適用を複数プロセス間で直列化する advisory lock
 * （`withAdvisoryLock`）もここで実装する。
 */
// `pg` は CommonJS パッケージのため、default export をいったん受けてから
// 分割代入する。こうすることで Node の ESM ローダー（tsx ランタイム）でも
// テストバンドラーでも named export として解決できるようにしている。
import pg from 'pg';
import type { SqlDatabase, SqlParam } from './sqlDatabase';
import { DEFAULT_POSTGRES_TIMEOUTS, type PostgresTimeouts } from './postgresTimeouts';

const { Pool } = pg;
type PoolClient = pg.PoolClient;
type Pool = pg.Pool;

// `pg` は lock_timeout を実行時に扱うが、現行の @types/pg は PoolConfig に
// そのプロパティを公開していないため、実装が受け付ける設定だけを補う。
type PoolConfigWithLockTimeout = pg.PoolConfig & { lock_timeout: number };

// 1サーバープロセスあたりのコネクションプール上限。Hubble は単一プロセスの
// サーバーであり大きなプールを必要としないため、控えめな値にしている。
const POOL_MAX = 5;

/**
 * プール（呼び出しごとに接続を取得）またはトランザクション中の固定クライアント
 * 上で SQL を実行する。両方の経路で行の取り扱いを共有する。
 *
 * クエリ実行の抽象。プール経由（呼び出しごとにコネクションを取得して返却）と、
 * トランザクション中に固定された単一クライアント経由のどちらの場合も同じ
 * インターフェースで扱えるようにし、行の取り扱いを1箇所にまとめている。
 */
interface PgExecutor {
  query(text: string, values: unknown[]): Promise<{ rows: unknown[] }>;
}

/** transaction deadline の超過を識別するエラー。 */
export class PostgresTransactionTimeoutError extends Error {
  readonly code = 'DATABASE_TRANSACTION_TIMEOUT';

  constructor(readonly timeoutMs: number) {
    super(`PostgreSQL transaction exceeded ${timeoutMs} ms`);
    this.name = 'PostgresTransactionTimeoutError';
  }
}

interface PinnedClient extends PgExecutor {
  release(destroy?: boolean | Error): void;
}

/**
 * 1本の PostgreSQL client 上で transaction を期限付き実行する。
 *
 * 期限超過時は接続を pool へ戻さず破棄し、未確定の transaction を切断で rollback
 * する。COMMIT の送信と期限が競合した場合、commit の成否はこの層では確定しない。
 * callback 自体は任意の Promise を await できて中断不能なため、遅れて再開しても
 * 同じ client へ SQL を送らないよう executor も無効化する。
 */
export async function runPostgresTransaction<T>(
  client: PinnedClient,
  timeoutMs: number,
  fn: (executor: PgExecutor) => Promise<T>,
): Promise<T> {
  let active = true;
  let released = false;
  const timeoutError = new PostgresTransactionTimeoutError(timeoutMs);
  const executor: PgExecutor = {
    query: (text, values) => {
      if (!active) return Promise.reject(new Error('PostgreSQL transaction is no longer active'));
      return client.query(text, values);
    },
  };
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      active = false;
      reject(timeoutError);
    }, timeoutMs);
  });
  const work = Promise.resolve().then(async () => {
    let began = false;
    try {
      await executor.query('BEGIN', []);
      began = true;
      const result = await fn(executor);
      await executor.query('COMMIT', []);
      return result;
    } catch (err) {
      if (began && active) {
        // callback または COMMIT の失敗時は、同じ絶対期限の残り時間内で rollback する。
        await executor.query('ROLLBACK', []);
      }
      throw err;
    }
  });

  try {
    return await Promise.race([work, deadline]);
  } catch (err) {
    active = false;
    if (err === timeoutError) {
      // deadline 後に callback が再開して reject しても unhandled rejection にしない。
      void work.catch(() => undefined);
      client.release(true);
      released = true;
      throw err;
    }
    throw err;
  } finally {
    active = false;
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    // deadline で破棄済みの場合を除き、成功でも失敗でも接続を pool へ一度だけ返す。
    if (!released) client.release();
  }
}

// PostgreSQL 用の SqlDatabase 実装本体。プールに直結したインスタンス（トップ
// レベル）と、トランザクション中に1つのクライアントへピン留めされたインス
// タンス（transaction() 内で生成）の2種類の使われ方をする。
class PostgresDatabase implements SqlDatabase {
  constructor(
    private readonly executor: PgExecutor,
    // pool はプール直結インスタンスにのみ存在し、トランザクションハンドル
    // （子インスタンス）には存在しない。これにより「自分がトップレベルの
    // ハンドルかどうか」を判定できる。
    private readonly pool?: Pool,
    private readonly transactionTimeoutMs = DEFAULT_POSTGRES_TIMEOUTS.transactionMs,
  ) {}

  async query<T = Record<string, unknown>>(
    sql: string,
    params: readonly SqlParam[] = [],
  ): Promise<T[]> {
    // 呼び出し側で番号付けした PostgreSQL SQL をそのまま実行し、結果行を返す。
    const res = await this.executor.query(sql, params as SqlParam[]);
    return res.rows as T[];
  }

  async run(sql: string, params: readonly SqlParam[] = []): Promise<void> {
    // query() と同じ実行経路を使うが、戻り値の行は呼び出し側に返さない。
    await this.executor.query(sql, params as SqlParam[]);
  }

  async exec(sql: string): Promise<void> {
    // マイグレーションスクリプトはパラメータを持たない静的な DDL のため、
    // SQL を変換せずに実行する。
    await this.executor.query(sql, []);
  }

  async transaction<T>(fn: (tx: SqlDatabase) => Promise<T>): Promise<T> {
    if (!this.pool) {
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
    return runPostgresTransaction(client, this.transactionTimeoutMs, async (executor) => {
      const tx = new PostgresDatabase(executor, undefined, this.transactionTimeoutMs);
      return fn(tx);
    });
  }

  async close(): Promise<void> {
    // トランザクション用の子インスタンスは pool を持たないため何もしない。
    // プール直結インスタンスのみプール全体を終了させる。
    if (this.pool) await this.pool.end();
  }

  /**
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
 * アプリ永続化用 PostgreSQL pool を構築する。
 *
 * 各期限は startup parameter として全コネクションへ適用される。接続 URL 内の同名
 * パラメーターが環境変数由来の値を上書きしないよう、URL 側の値は除外する。
 */
export function createPostgresPool(
  connectionString: string,
  timeouts: PostgresTimeouts = DEFAULT_POSTGRES_TIMEOUTS,
): Pool {
  const url = new URL(connectionString);
  url.searchParams.delete('statement_timeout');
  url.searchParams.delete('lock_timeout');
  url.searchParams.delete('idle_in_transaction_session_timeout');
  const existingOptions = url.searchParams.get('options')?.trim();
  url.searchParams.delete('options');
  const enforcedOptions = [
    existingOptions,
    `-c statement_timeout=${timeouts.statementMs}`,
    `-c lock_timeout=${timeouts.lockMs}`,
    `-c idle_in_transaction_session_timeout=${timeouts.idleTransactionMs}`,
  ]
    .filter((value): value is string => value !== undefined && value !== '')
    .join(' ');

  const options: PoolConfigWithLockTimeout = {
    connectionString: url.toString(),
    max: POOL_MAX,
    connectionTimeoutMillis: timeouts.connectionMs,
    statement_timeout: timeouts.statementMs,
    lock_timeout: timeouts.lockMs,
    idle_in_transaction_session_timeout: timeouts.idleTransactionMs,
    options: enforcedOptions,
  };
  return new Pool(options);
}

/**
 * 接続文字列から PostgreSQL 版の `SqlDatabase` を開く。コネクションプールを
 * 生成し、プールに直結した `PostgresDatabase` インスタンスを返す。呼び出し
 * 側（db/index.ts の `openDatabase`）が、advisory lock 下でのマイグレーション
 * 実行を責務として持つ。
 */
export function openPostgres(
  connectionString: string,
  timeouts: PostgresTimeouts = DEFAULT_POSTGRES_TIMEOUTS,
): SqlDatabase {
  const pool = createPostgresPool(connectionString, timeouts);
  return new PostgresDatabase(
    { query: (text, values) => pool.query(text, values) },
    pool,
    timeouts.transactionMs,
  );
}
