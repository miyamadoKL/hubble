/**
 * SQLite 向けの `SqlDatabase` アダプター実装。
 *
 * better-sqlite3 は同期 API しか持たないため、このモジュールでは各呼び出し
 * 結果を `Promise.resolve()` でラップし、リポジトリ層が前提とする非同期
 * インターフェース（`SqlDatabase`）に合わせている。トランザクションは
 * better-sqlite3 組み込みの `.transaction()` ではなく、BEGIN/COMMIT/ROLLBACK
 * を明示的に発行する形で実装する（理由はクラス内コメント参照）。
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { SqlDatabase, SqlParam } from './sqlDatabase';

/**
 * SqlDatabase backed by better-sqlite3. better-sqlite3 is synchronous; we wrap
 * each call so the result is a resolved Promise, matching the async interface
 * the repositories program against. WAL / foreign_keys PRAGMAs match the
 * historical behaviour of `openDatabase`.
 *
 * better-sqlite3 を用いた `SqlDatabase` 実装。better-sqlite3 自体は同期
 * API なので、各メソッドは同期処理の結果を `Promise.resolve()` で包んで
 * 返し、リポジトリ層が期待する非同期インターフェースに適合させている。
 * WAL モード / 外部キー制約の有効化（PRAGMA）は、従来の `openDatabase` の
 * 挙動を踏襲している。
 */
class SqliteDatabase implements SqlDatabase {
  readonly dialect = 'sqlite' as const;

  constructor(private readonly db: Database.Database) {}

  query<T = Record<string, unknown>>(sql: string, params: readonly SqlParam[] = []): Promise<T[]> {
    // prepare().all() は同期的に全行を配列で返す。それを解決済み Promise で包む。
    const rows = this.db.prepare(sql).all(...(params as SqlParam[])) as T[];
    return Promise.resolve(rows);
  }

  run(sql: string, params: readonly SqlParam[] = []): Promise<void> {
    // 副作用のみが目的の文（INSERT/UPDATE/DELETE）を実行する。戻り値の行は使わない。
    this.db.prepare(sql).run(...(params as SqlParam[]));
    return Promise.resolve();
  }

  exec(sql: string): Promise<void> {
    // パラメータなしで複数文をまとめて実行する（マイグレーションスクリプト等）。
    this.db.exec(sql);
    return Promise.resolve();
  }

  async transaction<T>(fn: (tx: SqlDatabase) => Promise<T>): Promise<T> {
    // better-sqlite3's own `.transaction()` cannot span an `await`, so we drive
    // BEGIN/COMMIT/ROLLBACK explicitly. Our callbacks only issue synchronous
    // better-sqlite3 calls, so no real concurrency crosses the boundary.
    // better-sqlite3 が提供する `.transaction()` ヘルパーは、コールバック内で
    // await を挟むこと（非同期処理をまたぐこと）ができない制約があるため、
    // ここでは BEGIN/COMMIT/ROLLBACK を自前で発行して制御する。呼び出し元の
    // コールバック（fn）は better-sqlite3 の同期呼び出ししか行わない前提なので、
    // このトランザクション境界を実際の並行処理がまたぐことはない。
    this.db.exec('BEGIN');
    try {
      // fn には自分自身（this）を tx ハンドルとして渡す。SQLite は
      // ネストしたトランザクションを持たず、常に単一のコネクション上で
      // 直列に実行されるため、PostgreSQL アダプターのようにクライアントを
      // 差し替える必要がない。
      const result = await fn(this);
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      // fn が例外を投げたらロールバックしてから再送出する。
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  close(): Promise<void> {
    this.db.close();
    return Promise.resolve();
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
