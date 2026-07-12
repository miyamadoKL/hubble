/**
 * ResultStore object の削除 outbox を管理する永続化層。
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
         VALUES (?, 0, ?, NULL, ?, ?)
         ON CONFLICT (object_key) DO NOTHING`,
        [key, nowIso, nowIso, nowIso],
      );
    }
  }

  /**
   * 削除時刻を迎えたジョブを返す。
   * H11 の単一 replica 制約下では ResultExpiryService が直列実行する。
   * 複数 replica を許可する場合は、DB 上の lease を使う分散 claim が必要になる。
   */
  async claimDue(nowIso: string, limit: number): Promise<ResultObjectDeletionJob[]> {
    const rows = await this.db.query<ResultObjectDeletionRow>(
      `SELECT * FROM result_object_deletions
       WHERE next_attempt_at <= ?
       ORDER BY next_attempt_at ASC, object_key ASC
       LIMIT ?`,
      [nowIso, limit],
    );
    return rows.map(rowToJob);
  }

  /** 削除に成功したジョブを完了として取り除く。 */
  async complete(keys: readonly string[]): Promise<void> {
    for (const key of new Set(keys)) {
      await this.db.run('DELETE FROM result_object_deletions WHERE object_key = ?', [key]);
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
       SET attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
       WHERE object_key = ?`,
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
