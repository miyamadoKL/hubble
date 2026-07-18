/**
 * JSONL result object の削除 outbox を管理する永続化層。
 *
 * `store/*` 全体として、Kysely や generic CRUD 基底 class は採用しない。この
 * ファイルは `store/*` の中で最小の repository（SQL 文 6 件、動的 SQL と
 * transaction は 0 件）だが、それでも Kysely 導入は見送っている。既存の
 * `PostgresDatabase` は pool を private に保持し、`transaction()` が 60 秒
 * deadline とクライアント破棄を、`withAdvisoryLock()` が同じ pool から借りた
 * session lock 用クライアントを所有している。Kysely の `PostgresDialect` に
 * 第二の `Pool` を持たせると pool owner が増え、既存 pool を渡すには db
 * factory、close ownership、transaction deadline と advisory lock の境界を
 * 追加実装する必要がある。その追加分が、最小候補ですら必要な正味 20%
 * 削減（35.2 行以上）を先に消費してしまうため、query builder への移行は
 * 見送った。document revision、favorite、summary の差を flag や callback で
 * 隠す generic 基底 class も、同じ理由で wrong abstraction として避けている。
 */
import type { SqlDatabase } from '../db/sqlDatabase';

/** 削除時刻を迎えた ResultStore object の削除ジョブ。 */
export interface ResultObjectDeletionJob {
  key: string;
  attempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ResultObjectDeletionRow {
  object_key: string;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function rowToJob(row: ResultObjectDeletionRow): ResultObjectDeletionJob {
  return {
    key: row.object_key,
    attempts: Number(row.attempts),
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** ResultStore object の削除予定と再試行状態を管理する repository。 */
export class ResultObjectDeletionRepository {
  constructor(private readonly db: SqlDatabase) {}

  /** object key を削除予定へ冪等に追加する。 */
  async enqueue(keys: readonly string[], nowIso: string): Promise<void> {
    for (const key of new Set(keys)) {
      await this.db.run(
        `INSERT INTO result_object_deletions
           (object_key, attempts, next_attempt_at, last_error, created_at, updated_at)
         VALUES ($1, 0, $2, NULL, $3, $4)
         ON CONFLICT (object_key) DO NOTHING`,
        [key, nowIso, nowIso, nowIso],
      );
    }
  }

  /** query の JSONL または workflow の live 行が object key を参照しているか確認する。 */
  async isReferenced(key: string): Promise<boolean> {
    const rows = await this.db.query<{ object_key: string }>(
      `SELECT object_key FROM (
         SELECT result_object_key AS object_key
         FROM query_history WHERE result_object_key = $1
         UNION ALL
         SELECT result_object_key AS object_key
         FROM workflow_step_runs WHERE result_object_key = $2
       ) AS live_result_refs
       LIMIT 1`,
      [key, key],
    );
    return rows.length > 0;
  }

  /**
   * 削除時刻を迎えたジョブを返す。
   * H11 の単一 replica 制約下では ResultExpiryService が直列実行する。
   * 複数 replica を許可する場合は、DB 上の lease を使う分散 claim が必要になる。
   */
  async claimDue(nowIso: string, limit: number): Promise<ResultObjectDeletionJob[]> {
    const rows = await this.db.query<ResultObjectDeletionRow>(
      `SELECT * FROM result_object_deletions
       WHERE next_attempt_at <= $1
       ORDER BY next_attempt_at ASC, object_key ASC
       LIMIT $2`,
      [nowIso, limit],
    );
    return rows.map(rowToJob);
  }

  /** 削除に成功したジョブを完了として取り除く。 */
  async complete(keys: readonly string[]): Promise<void> {
    for (const key of new Set(keys)) {
      await this.db.run('DELETE FROM result_object_deletions WHERE object_key = $1', [key]);
    }
  }

  /** 削除失敗を記録し、次回の試行時刻を更新する。 */
  async markRetry(
    key: string,
    attempts: number,
    nextAttemptAtIso: string,
    error: string,
    nowIso: string,
  ): Promise<void> {
    await this.db.run(
      `UPDATE result_object_deletions
       SET attempts = $1, next_attempt_at = $2, last_error = $3, updated_at = $4
       WHERE object_key = $5`,
      [attempts, nextAttemptAtIso, error, nowIso, key],
    );
  }

  /** テストと運用確認用に全ジョブを key 順で返す。 */
  async listForTest(): Promise<ResultObjectDeletionJob[]> {
    const rows = await this.db.query<ResultObjectDeletionRow>(
      'SELECT * FROM result_object_deletions ORDER BY object_key ASC',
    );
    return rows.map(rowToJob);
  }
}
