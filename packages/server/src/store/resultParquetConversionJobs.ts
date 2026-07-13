/**
 * JSONL から Parquet への変換を再起動後も継続する durable job の永続化層。
 *
 * job は pending のまま処理される。worker は単一 replica の直列実行を前提に
 * し、実行中状態を DB に持たないことで、途中終了時も次回起動時に同じ行を
 * そのまま再処理できるようにする。
 */
import type { SqlDatabase } from '../db/sqlDatabase';

export const RESULT_PARQUET_CONVERSION_ENCODING_VERSION = '1';

/** DB に残る状態。complete/obsolete は終端処理時に row を削除するため保存しない。 */
export type ResultParquetConversionJobStatus = 'pending' | 'dead';

/** enqueue 時に固定する変換対象。targetObjectKey は retry で再生成しない。 */
export interface ResultParquetConversionJobInput {
  historyId: string;
  sourceObjectKey: string;
  targetObjectKey: string;
  encodingVersion: string;
}

/** 永続化された Parquet 変換 job。 */
export interface ResultParquetConversionJob extends ResultParquetConversionJobInput {
  status: ResultParquetConversionJobStatus;
  attempts: number;
  nextAttemptAt: string;
  lastErrorCode: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ResultParquetConversionJobRow {
  history_id: string;
  source_object_key: string;
  target_object_key: string;
  encoding_version: string;
  status: string;
  attempts: number;
  next_attempt_at: string;
  last_error_code: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function rowToJob(row: ResultParquetConversionJobRow): ResultParquetConversionJob {
  return {
    historyId: row.history_id,
    sourceObjectKey: row.source_object_key,
    targetObjectKey: row.target_object_key,
    encodingVersion: row.encoding_version,
    status: row.status as ResultParquetConversionJobStatus,
    attempts: Number(row.attempts),
    nextAttemptAt: row.next_attempt_at,
    lastErrorCode: row.last_error_code,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Parquet 変換 job の登録、retry、終端状態を管理する repository。 */
export class ResultParquetConversionJobRepository {
  constructor(private readonly db: SqlDatabase) {}

  /**
   * 変換 job を履歴 id で冪等に登録する。
   * 同じ履歴 id が既に存在する場合は、保存済み target key を返す。
   */
  async enqueue(
    input: ResultParquetConversionJobInput,
    nowIso: string,
    database: SqlDatabase = this.db,
  ): Promise<ResultParquetConversionJob> {
    await database.run(
      `INSERT INTO result_parquet_conversion_jobs
         (history_id, source_object_key, target_object_key, encoding_version,
          status, attempts, next_attempt_at, last_error_code, last_error,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, ?, ?)
       ON CONFLICT (history_id) DO NOTHING`,
      [
        input.historyId,
        input.sourceObjectKey,
        input.targetObjectKey,
        input.encodingVersion,
        nowIso,
        nowIso,
        nowIso,
      ],
    );
    const job = await this.get(input.historyId, database);
    if (!job) throw new Error(`Result Parquet conversion job disappeared: ${input.historyId}`);
    return job;
  }

  /** 指定時刻までに retry 可能な pending job を安定した順序で取得する。 */
  async claimDue(
    nowIso: string,
    limit: number,
    database: SqlDatabase = this.db,
  ): Promise<ResultParquetConversionJob[]> {
    const boundedLimit = Math.min(Math.max(limit, 1), 1_000);
    const rows = await database.query<ResultParquetConversionJobRow>(
      `SELECT * FROM result_parquet_conversion_jobs
       WHERE status='pending' AND next_attempt_at <= ?
       ORDER BY next_attempt_at ASC, history_id ASC
       LIMIT ?`,
      [nowIso, boundedLimit],
    );
    return rows.map(rowToJob);
  }

  /** job の現在値を返す。 */
  async get(
    historyId: string,
    database: SqlDatabase = this.db,
  ): Promise<ResultParquetConversionJob | undefined> {
    const rows = await database.query<ResultParquetConversionJobRow>(
      'SELECT * FROM result_parquet_conversion_jobs WHERE history_id=?',
      [historyId],
    );
    return rows[0] ? rowToJob(rows[0]) : undefined;
  }

  /** 変換と Parquet link が完了した job を削除する。 */
  async markComplete(
    historyId: string,
    nowIso: string,
    database: SqlDatabase = this.db,
  ): Promise<void> {
    void nowIso;
    await database.run('DELETE FROM result_parquet_conversion_jobs WHERE history_id=?', [
      historyId,
    ]);
  }

  /** 変換対象が失効または履歴不整合になった job を削除する。 */
  async markObsolete(
    historyId: string,
    code: string,
    error: string,
    nowIso: string,
    database: SqlDatabase = this.db,
  ): Promise<void> {
    void code;
    void error;
    void nowIso;
    await database.run('DELETE FROM result_parquet_conversion_jobs WHERE history_id=?', [
      historyId,
    ]);
  }

  /** 永続的な入力不備を dead として記録する。 */
  async markDead(
    historyId: string,
    attempts: number,
    code: string,
    error: string,
    nowIso: string,
    database: SqlDatabase = this.db,
  ): Promise<void> {
    await database.run(
      `UPDATE result_parquet_conversion_jobs
       SET status='dead', attempts=?, last_error_code=?, last_error=?, updated_at=?
       WHERE history_id=?`,
      [attempts, code, error, nowIso, historyId],
    );
  }

  /** retry 可能な失敗を pending のまま次回時刻へ進める。 */
  async markRetry(
    historyId: string,
    attempts: number,
    nextAttemptAtIso: string,
    code: string,
    error: string,
    nowIso: string,
    database: SqlDatabase = this.db,
  ): Promise<void> {
    await database.run(
      `UPDATE result_parquet_conversion_jobs
       SET status='pending', attempts=?, next_attempt_at=?, last_error_code=?,
           last_error=?, updated_at=?
       WHERE history_id=?`,
      [attempts, nextAttemptAtIso, code, error, nowIso, historyId],
    );
  }

  /** 期限切れの dead row を bounded に削除する。 */
  async pruneDead(
    beforeIso: string,
    limit: number,
    database: SqlDatabase = this.db,
  ): Promise<number> {
    const boundedLimit = Math.min(Math.max(limit, 1), 1_000);
    const rows = await database.query<{ history_id: string }>(
      `DELETE FROM result_parquet_conversion_jobs
       WHERE status='dead' AND updated_at < ?
         AND history_id IN (
           SELECT history_id FROM result_parquet_conversion_jobs
           WHERE status='dead' AND updated_at < ?
           ORDER BY updated_at ASC, history_id ASC
           LIMIT ?
         )
       RETURNING history_id`,
      [beforeIso, beforeIso, boundedLimit],
    );
    return rows.length;
  }

  /** 指定 job を明示的に削除する。運用時の replay/prune 用。 */
  async delete(historyId: string, database: SqlDatabase = this.db): Promise<void> {
    await database.run('DELETE FROM result_parquet_conversion_jobs WHERE history_id=?', [
      historyId,
    ]);
  }

  /** テストと運用確認用に全 job を履歴 id 順で返す。 */
  async listForTest(database: SqlDatabase = this.db): Promise<ResultParquetConversionJob[]> {
    const rows = await database.query<ResultParquetConversionJobRow>(
      'SELECT * FROM result_parquet_conversion_jobs ORDER BY history_id ASC',
    );
    return rows.map(rowToJob);
  }
}

/** A2 の Parquet target key。enqueue 後は job の値だけを使い、再生成しない。 */
export function buildResultParquetObjectKey(prefix: string, historyId: string): string {
  return `${prefix}${historyId}.parquet`;
}
