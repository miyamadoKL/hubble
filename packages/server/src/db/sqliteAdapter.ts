/**
 * SQLite 向けの `SqlDatabase` アダプター実装。
 *
 * better-sqlite3 は同期 API しか持たないため、このモジュールでは各操作を
 * 接続単位のキューで直列化し、リポジトリ層が前提とする非同期インター
 * フェース（`SqlDatabase`）に合わせている。トランザクションは
 * better-sqlite3 組み込みの `.transaction()` ではなく、BEGIN/COMMIT/ROLLBACK
 * を明示的に発行する形で実装する（理由はクラス内コメント参照）。
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { SqlDatabase, SqlParam } from './sqlDatabase';

/** SQLite の単一接続へ発行する非同期操作を呼び出し順に直列化する。 */
class SqliteOperationQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

interface SqliteTransactionState {
  active: boolean;
}

/**
 * better-sqlite3 を用いた `SqlDatabase` 実装。
 * 公開ハンドルの操作は単一キューへ積み、非同期コールバックを含むトランザク
 * ションの途中へ別操作が混入しないようにする。
 * トランザクション専用ハンドルだけは取得済みの排他区間を直接利用する。
 * WAL モードと外部キー制約の有効化は、従来の `openDatabase` の挙動を踏襲する。
 */
class SqliteDatabase implements SqlDatabase {
  readonly dialect = 'sqlite' as const;

  constructor(
    private readonly db: Database.Database,
    private readonly queue = new SqliteOperationQueue(),
    private readonly transactionState?: SqliteTransactionState,
  ) {}

  private execute<T>(operation: () => T): Promise<T> {
    if (!this.transactionState) return this.queue.run(operation);
    if (!this.transactionState.active) {
      return Promise.reject(new Error('SQLite transaction handle is no longer active'));
    }
    try {
      return Promise.resolve(operation());
    } catch (err) {
      return Promise.reject(err);
    }
  }

  query<T = Record<string, unknown>>(sql: string, params: readonly SqlParam[] = []): Promise<T[]> {
    // prepare().all() は同期的に全行を配列で返し、キューが結果を Promise で返す。
    return this.execute(() => this.db.prepare(sql).all(...(params as SqlParam[])) as T[]);
  }

  run(sql: string, params: readonly SqlParam[] = []): Promise<void> {
    // 副作用のみが目的の文（INSERT/UPDATE/DELETE）を実行する。戻り値の行は使わない。
    return this.execute(() => {
      this.db.prepare(sql).run(...(params as SqlParam[]));
    });
  }

  exec(sql: string): Promise<void> {
    // パラメータなしで複数文をまとめて実行する（マイグレーションスクリプト等）。
    return this.execute(() => {
      this.db.exec(sql);
    });
  }

  async transaction<T>(fn: (tx: SqlDatabase) => Promise<T>): Promise<T> {
    // better-sqlite3 が提供する `.transaction()` ヘルパーは、コールバック内で
    // await を挟むこと（非同期処理をまたぐこと）ができない制約があるため、
    // BEGIN/COMMIT/ROLLBACK を明示的に発行する。トランザクション用ハンドルは
    // 取得済みの排他区間を直接使い、外側のキューを再取得しない。
    if (this.transactionState) {
      if (!this.transactionState.active) {
        throw new Error('SQLite transaction handle is no longer active');
      }
      return fn(this);
    }

    return this.queue.run(async () => {
      this.db.exec('BEGIN');
      const state: SqliteTransactionState = { active: true };
      const tx = new SqliteDatabase(this.db, this.queue, state);
      try {
        const result = await fn(tx);
        this.db.exec('COMMIT');
        return result;
      } catch (err) {
        // fn が例外を投げたらロールバックしてから再送出する。
        this.db.exec('ROLLBACK');
        throw err;
      } finally {
        state.active = false;
      }
    });
  }

  close(): Promise<void> {
    // トランザクション用ハンドルからは共有接続を閉じない。
    if (this.transactionState) return Promise.resolve();
    return this.queue.run(() => {
      this.db.close();
    });
  }
}

/**
 * Open (or create) a SQLite database at `dbPath` and return the async adapter.
 * Pass ':memory:' for tests. Caller is responsible for running migrations.
 *
 * `dbPath` の SQLite データベースを開く（存在しなければ新規作成する）。
 * テストでは ':memory:' を渡してオンメモリの一時データベースを使う。
 * マイグレーションの実行は呼び出し側（db/index.ts の `openDatabase`）の
 * 責務であり、このヘルパー自体はマイグレーションを行わない。
 */
export function openSqlite(dbPath: string): SqlDatabase {
  if (dbPath !== ':memory:') {
    // ファイルベースの DB の場合、親ディレクトリが存在しなければ作成する
    // （':memory:' はファイルシステム上のパスではないため対象外）。
    mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  }
  const db = new Database(dbPath);
  // WAL（Write-Ahead Logging）モードにすることで読み書きの同時実行性を上げる。
  db.pragma('journal_mode = WAL');
  // 外部キー制約はデフォルトで無効なため明示的に有効化する。
  db.pragma('foreign_keys = ON');
  return new SqliteDatabase(db);
}
