/**
 * スケジュール実行機能（Query Scheduling）の永続化層。
 *
 * - `ScheduleRepository`: `schedules` テーブルに対する CRUD。スケジュール定義
 *   （実行する SQL 文、cron 式、リトライポリシーなど）を owner（principal）ごとに
 *   管理する。
 * - `ScheduleRunRepository`: `schedule_runs` テーブルに対する CRUD。個々の
 *   実行結果（成功/失敗、行数、経過時間など）を記録し、スケジュールごとの
 *   保持件数（retention）を超えた古い行を間引く。
 *
 * PostgreSQLで真偽値は 0/1 の INTEGER として、日時は ISO 8601 文字列として保存する。
 * アーキテクチャ上は packages/server/src/db/ の `SqlDatabase` 抽象の上に乗る
 * リポジトリ層であり、上位の routes 層が契約型 `Schedule`（`nextRunAt` /
 * `lastRun` の付与）への変換や、cron スケジューラーのポーリングを担当する。
 */
import { z } from 'zod';
import type {
  RetryPolicy,
  ScheduleNotifications,
  ScheduleRunStatus,
  ScheduleRunSummary,
} from '@hubble/contracts';
import {
  defaultScheduleNotifications,
  retryPolicySchema,
  scheduleNotificationsSchema,
} from '@hubble/contracts';
import type { PrincipalIdentity } from '../auth/principal';
import type { SqlDatabase, SqlParam } from '../db/sqlDatabase';
import { newId } from '../util/id';
import { AppError } from '../errors';

const SQL_ID_CHUNK_SIZE = 500;

export const schedulePrincipalSnapshotSchema = z.object({
  user: z.string().min(1),
  email: z.string().min(1).optional(),
  groups: z.array(z.string().min(1)).optional(),
});

export type SchedulePrincipalSnapshot = z.infer<typeof schedulePrincipalSnapshotSchema>;

/**
 * DB に保存されているスケジュールそのものの形。レスポンス専用の派生フィールド
 * （`nextRunAt`, `lastRun`）は含まれない。これらは routes 層で契約型 `Schedule`
 * へ変換する際に付与される。
 */
export interface ScheduleRecord {
  id: string;
  /** スケジュールの所有者（principal）。全操作の絞り込みキーになる。 */
  owner: string;
  name: string;
  /** 定期実行される SQL 文。 */
  statement: string;
  /** 既定のカタログ（未指定なら null）。 */
  catalog: string | null;
  /** 既定のスキーマ（未指定なら null）。 */
  schema: string | null;
  /** 実行タイミングを表す cron 式。 */
  cron: string;
  /** 無効化されたスケジュールはスケジューラーが拾わない。 */
  enabled: boolean;
  /** 失敗時の再試行ポリシー（最大試行回数、待機時間、倍率）。 */
  retry: RetryPolicy;
  /** 確定失敗時の外部通知設定。 */
  notifications: ScheduleNotifications;
  /** 実行先データソース id（作成/更新時に解決して永続化）。 */
  datasourceId: string;
  /**
   * 作成/更新時点の principal スナップショット。歴史的な null は読み出せるが、実行時に拒否する。
   */
  principalSnapshot: SchedulePrincipalSnapshot | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * スケジュール作成時に呼び出し元が指定できるフィールド。省略可能なものは
 * `create()` 内で既定値（enabled=true, retry=デフォルトポリシー）が補われる。
 */
export interface CreateScheduleInput {
  name: string;
  statement: string;
  catalog?: string | null;
  schema?: string | null;
  cron: string;
  enabled?: boolean;
  retry?: RetryPolicy;
  /** 確定失敗時の外部通知設定。 */
  notifications?: ScheduleNotifications;
  /** 実行先データソース id（ルート層で省略時は既定に解決済み）。 */
  datasourceId: string;
  /** 作成時点の principal。email/group assignment を実行時にも再現するため保存する。 */
  principalSnapshot: PrincipalIdentity;
}

/**
 * スケジュール更新用の部分入力。指定されたキーのみが既存値を上書きする
 * （undefined のフィールドは既存値を維持）。
 */
export interface UpdateScheduleInput {
  name?: string;
  statement?: string;
  catalog?: string | null;
  schema?: string | null;
  cron?: string;
  enabled?: boolean;
  retry?: RetryPolicy;
  notifications?: ScheduleNotifications;
  datasourceId?: string;
  /**
   * owner 本人がスケジュールを更新した時点の principal。
   * 今回はそれ以外の契機で email/groups を再解決しない。
   */
  principalSnapshot?: PrincipalIdentity;
}

/**
 * `schedules` テーブルの行を PostgreSQL がそのまま返す形。列名は snake_case、
 * `enabled` は 0/1 の INTEGER、リトライポリシーは
 * `retry_*` の3列に分割して保存されている（ドメイン上は `RetryPolicy` object）。
 */
interface ScheduleRow {
  id: string;
  owner: string;
  name: string;
  statement: string;
  catalog: string | null;
  schema: string | null;
  cron: string;
  enabled: number;
  retry_max_attempts: number;
  retry_backoff_seconds: number;
  retry_backoff_multiplier: number;
  notifications: string | null;
  datasource_id: string;
  principal_snapshot: string | null;
  created_at: string;
  updated_at: string;
}

type InvalidPrincipalSnapshotReason = 'json-parse' | 'schema-validate';
type InvalidNotificationsReason = 'json-parse' | 'schema-validate';

function warnInvalidPrincipalSnapshot(
  scheduleId: string,
  reason: InvalidPrincipalSnapshotReason,
): void {
  console.warn(`schedule principal_snapshot ignored: schedule_id=${scheduleId} reason=${reason}`);
}

function parsePrincipalSnapshot(
  scheduleId: string,
  raw: string | null,
): SchedulePrincipalSnapshot | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    warnInvalidPrincipalSnapshot(scheduleId, 'json-parse');
    return null;
  }
  const result = schedulePrincipalSnapshotSchema.safeParse(parsed);
  if (!result.success) {
    warnInvalidPrincipalSnapshot(scheduleId, 'schema-validate');
    return null;
  }
  return result.data;
}

function serializePrincipalSnapshot(snapshot: PrincipalIdentity | null | undefined): string | null {
  if (!snapshot) return null;
  return JSON.stringify(
    schedulePrincipalSnapshotSchema.parse({
      user: snapshot.user,
      ...(snapshot.email !== undefined ? { email: snapshot.email } : {}),
      ...(snapshot.groups !== undefined ? { groups: snapshot.groups } : {}),
    }),
  );
}

function warnInvalidNotifications(scheduleId: string, reason: InvalidNotificationsReason): void {
  console.warn(`schedule notifications ignored: schedule_id=${scheduleId} reason=${reason}`);
}

function parseNotifications(scheduleId: string, raw: string | null): ScheduleNotifications {
  if (raw === null) return defaultScheduleNotifications;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    warnInvalidNotifications(scheduleId, 'json-parse');
    return defaultScheduleNotifications;
  }
  const result = scheduleNotificationsSchema.safeParse(parsed);
  if (!result.success) {
    warnInvalidNotifications(scheduleId, 'schema-validate');
    return defaultScheduleNotifications;
  }
  return result.data;
}

function serializeNotifications(notifications: ScheduleNotifications | undefined): string {
  return JSON.stringify(scheduleNotificationsSchema.parse(notifications ?? {}));
}

// DB 行（snake_case でフラットな retry_* 列）をドメインオブジェクト
// `ScheduleRecord`（camelCase でネストした retry object）へ変換する。
function rowToSchedule(row: ScheduleRow): ScheduleRecord {
  return {
    id: row.id,
    owner: row.owner,
    name: row.name,
    statement: row.statement,
    catalog: row.catalog ?? null,
    schema: row.schema ?? null,
    cron: row.cron,
    // PostgreSQLのINTEGER列を数値化してから 0 かどうかで真偽値化する。
    enabled: Number(row.enabled) !== 0,
    // retry_max_attempts / retry_backoff_seconds / retry_backoff_multiplier の
    // 3列を RetryPolicy object にまとめ、スキーマでバリデーションする。
    retry: retryPolicySchema.parse({
      maxAttempts: Number(row.retry_max_attempts),
      backoffSeconds: Number(row.retry_backoff_seconds),
      backoffMultiplier: Number(row.retry_backoff_multiplier),
    }),
    notifications: parseNotifications(row.id, row.notifications),
    datasourceId: row.datasource_id,
    principalSnapshot: parsePrincipalSnapshot(row.id, row.principal_snapshot),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * スケジュール（Query Scheduling 機能）に対する CRUD リポジトリ。ほぼ全ての
 * 操作は `owner` principal で絞り込まれる。例外は
 * `listAllEnabled` で、これは全 owner を横断して有効なスケジュールを探す
 * ためにプロセス内スケジューラーの tick から使われる。
 */
export class ScheduleRepository {
  constructor(private readonly db: SqlDatabase) {}

  /** owner が所有する全スケジュールを更新日時の新しい順に返す。 */
  async list(owner: string): Promise<ScheduleRecord[]> {
    const rows = await this.db.query<ScheduleRow>(
      'SELECT * FROM schedules WHERE owner = $1 ORDER BY updated_at DESC',
      [owner],
    );
    return rows.map(rowToSchedule);
  }

  /** owner が所有する単一スケジュールを id で取得する。存在しなければ undefined。 */
  async get(owner: string, id: string): Promise<ScheduleRecord | undefined> {
    const rows = await this.db.query<ScheduleRow>(
      'SELECT * FROM schedules WHERE id = $1 AND owner = $2',
      [id, owner],
    );
    return rows[0] ? rowToSchedule(rows[0]) : undefined;
  }

  /** Fetch a schedule by id without owner scoping (scheduler internals only). */
  // owner による絞り込みなしで id のみでスケジュールを取得する。
  // スケジューラー内部（tick 処理）専用で、ルート層からは使わないこと。
  async getById(id: string): Promise<ScheduleRecord | undefined> {
    const rows = await this.db.query<ScheduleRow>('SELECT * FROM schedules WHERE id = $1', [id]);
    return rows[0] ? rowToSchedule(rows[0]) : undefined;
  }

  /** All enabled schedules across every owner (scheduler tick). */
  // 全 owner を横断して enabled = 1 のスケジュールを id 順に返す。
  // cron スケジューラーが毎 tick でどのスケジュールが実行対象かを判定するために使う。
  async listAllEnabled(): Promise<ScheduleRecord[]> {
    const rows = await this.db.query<ScheduleRow>(
      'SELECT * FROM schedules WHERE enabled = 1 ORDER BY id',
    );
    return rows.map(rowToSchedule);
  }

  /** 新しいスケジュールを作成する。id は `sch_` プレフィックス付きで採番される。 */
  async create(owner: string, input: CreateScheduleInput): Promise<ScheduleRecord> {
    if (!input.principalSnapshot) {
      throw AppError.badRequest(
        'A principal snapshot is required when creating a schedule',
        'PRINCIPAL_SNAPSHOT_REQUIRED',
      );
    }
    const nowIso = new Date().toISOString();
    // retry 未指定時はスキーマ既定値（zod のデフォルト）を採用する。
    const retry = input.retry ?? retryPolicySchema.parse({});
    const record: ScheduleRecord = {
      id: newId('sch_'),
      owner,
      name: input.name,
      statement: input.statement,
      catalog: input.catalog ?? null,
      schema: input.schema ?? null,
      cron: input.cron,
      enabled: input.enabled ?? true,
      retry,
      notifications: input.notifications ?? defaultScheduleNotifications,
      datasourceId: input.datasourceId,
      principalSnapshot: input.principalSnapshot,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    await this.db.run(
      `INSERT INTO schedules
         (id, owner, name, statement, catalog, schema, cron, enabled,
          retry_max_attempts, retry_backoff_seconds, retry_backoff_multiplier,
          notifications, datasource_id, principal_snapshot, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      insertParams(record),
    );
    return record;
  }

  /**
   * 既存スケジュールを部分更新する。未指定のフィールドは既存値を維持する
   * （catalog/schema は「未指定」と「明示的に null」を区別するため
   * `!== undefined` で判定する）。対象が owner のスケジュールとして
   * 存在しない場合は undefined を返す。
   */
  async update(
    owner: string,
    id: string,
    input: UpdateScheduleInput,
  ): Promise<ScheduleRecord | undefined> {
    const existing = await this.get(owner, id);
    if (!existing) return undefined;
    const merged: ScheduleRecord = {
      ...existing,
      name: input.name ?? existing.name,
      statement: input.statement ?? existing.statement,
      catalog: input.catalog !== undefined ? input.catalog : existing.catalog,
      schema: input.schema !== undefined ? input.schema : existing.schema,
      cron: input.cron ?? existing.cron,
      enabled: input.enabled ?? existing.enabled,
      retry: input.retry ?? existing.retry,
      notifications: input.notifications ?? existing.notifications,
      datasourceId: input.datasourceId ?? existing.datasourceId,
      principalSnapshot:
        input.principalSnapshot !== undefined
          ? input.principalSnapshot
          : existing.principalSnapshot,
      updatedAt: new Date().toISOString(),
    };
    await this.db.run(
      `UPDATE schedules SET
         name = $1, statement = $2, catalog = $3, schema = $4, cron = $5, enabled = $6,
         retry_max_attempts = $7, retry_backoff_seconds = $8, retry_backoff_multiplier = $9,
         notifications = $10, datasource_id = $11, principal_snapshot = $12, updated_at = $13
       WHERE id = $14 AND owner = $15`,
      [
        merged.name,
        merged.statement,
        merged.catalog,
        merged.schema,
        merged.cron,
        merged.enabled ? 1 : 0,
        merged.retry.maxAttempts,
        merged.retry.backoffSeconds,
        merged.retry.backoffMultiplier,
        serializeNotifications(merged.notifications),
        merged.datasourceId,
        serializePrincipalSnapshot(merged.principalSnapshot),
        merged.updatedAt,
        id,
        owner,
      ],
    );
    return merged;
  }

  /** スケジュール本体とその実行履歴を全て削除する。存在しなければ false。 */
  async delete(owner: string, id: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const deleted = await tx.query<{ id: string }>(
        'DELETE FROM schedules WHERE id = $1 AND owner = $2 RETURNING id',
        [id, owner],
      );
      if (deleted.length === 0) return false;
      // 外部キーの ON DELETE CASCADE を使っていない（migration 0003 参照）ため、
      // 同じ transaction で schedule_runs を削除してカスケードを模倣する。
      await tx.run('DELETE FROM schedule_runs WHERE schedule_id = $1', [id]);
      return true;
    });
  }
}

/** INSERT のプレースホルダ順に合わせて `ScheduleRecord` を配列化する。 */
function insertParams(s: ScheduleRecord): SqlParam[] {
  return [
    s.id,
    s.owner,
    s.name,
    s.statement,
    s.catalog,
    s.schema,
    s.cron,
    s.enabled ? 1 : 0,
    s.retry.maxAttempts,
    s.retry.backoffSeconds,
    s.retry.backoffMultiplier,
    serializeNotifications(s.notifications),
    s.datasourceId,
    serializePrincipalSnapshot(s.principalSnapshot),
    s.createdAt,
    s.updatedAt,
  ];
}

// ---------------------------------------------------------------------------
// schedule_runs テーブル（スケジュールの個々の実行履歴）
// ---------------------------------------------------------------------------

/**
 * `schedule_runs` テーブルの行を SQL ドライバがそのまま返す形。1行が1回の
 * 実行に対応し、開始時に `running` 状態で挿入され、終了時に結果列
 * （status, trino_query_id, error_*, row_count, elapsed_ms, finished_at）が
 * 更新される。
 */
interface ScheduleRunRow {
  id: string;
  schedule_id: string;
  owner: string;
  status: string;
  attempt: number;
  trino_query_id: string | null;
  error_type: string | null;
  error_message: string | null;
  row_count: number | null;
  elapsed_ms: number | null;
  scheduled_for: string;
  started_at: string;
  finished_at: string | null;
}

/**
 * 実行開始時に記録するフィールド。この時点では結果はまだ分からないため
 * status は常に `running` で挿入される。
 */
export interface StartRunInput {
  scheduleId: string;
  owner: string;
  /** 本来実行されるべきだった予定時刻（cron が指し示す時刻）。 */
  scheduledFor: string;
  /** 実際に実行を開始した時刻。 */
  startedAt: string;
}

/** 同一スケジュールの running claim が既に存在する。 */
export class ScheduleRunClaimConflictError extends Error {
  constructor(readonly scheduleId: string) {
    super(`A run is already in progress for schedule ${scheduleId}`);
    this.name = 'ScheduleRunClaimConflictError';
  }
}

/**
 * 実行終了時に記録するフィールド。1回の実行につき1行を更新する。
 */
export interface FinishRunInput {
  status: ScheduleRunStatus;
  /** 何回目の試行か（リトライ込み）。 */
  attempt: number;
  trinoQueryId?: string | null;
  errorType?: string | null;
  errorMessage?: string | null;
  rowCount?: number | null;
  elapsedMs?: number | null;
  finishedAt: string;
}

/** スケジュール実行の1レコード（契約型 `ScheduleRunSummary` に owner/scheduleId を加えたもの）。 */
export interface ScheduleRunRecord extends ScheduleRunSummary {
  scheduleId: string;
  owner: string;
}

// DB 行（snake_case）をドメインオブジェクト `ScheduleRunRecord` へ変換する。
// row_count / elapsed_ms は null 許容なので、null と数値を区別して変換する。
function rowToRun(row: ScheduleRunRow): ScheduleRunRecord {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    owner: row.owner,
    status: row.status as ScheduleRunStatus,
    attempt: Number(row.attempt),
    trinoQueryId: row.trino_query_id ?? null,
    errorType: row.error_type ?? null,
    errorMessage: row.error_message ?? null,
    rowCount: row.row_count === null ? null : Number(row.row_count),
    elapsedMs: row.elapsed_ms === null ? null : Number(row.elapsed_ms),
    scheduledFor: row.scheduled_for,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? null,
  };
}

/**
 * スケジュール実行1回1回の永続化を担う（Query Scheduling 機能）。実行開始時に
 * `running` 状態で1行 INSERT し、終了時にその行を終端状態（success/failed/
 * aborted 等）へ UPDATE する。スケジュールごとの保持上限（retention）を
 * 超えた古い行は `finish()` の都度 `prune()` で間引かれる。
 */
export class ScheduleRunRepository {
  constructor(
    private readonly db: SqlDatabase,
    // スケジュール1件あたりに保持する実行履歴行数の上限。0以下なら間引きを行わない。
    private readonly retention: number,
  ) {}

  /** Insert a `running` row and return its generated id. */
  /** `running` 行を原子的に claim し、生成した id を返す。 */
  // 実行開始時に呼ばれる。attempt=0 かつ status='running' で1行挿入し、
  // 生成した run id を返す（finish() で同じ id を使って更新する）。
  async start(input: StartRunInput): Promise<string> {
    const id = newId('run_');
    const inserted = await this.db.query<{ id: string }>(
      `INSERT INTO schedule_runs
         (id, schedule_id, owner, status, attempt, scheduled_for, started_at)
       VALUES ($1, $2, $3, 'running', 0, $4, $5)
       ON CONFLICT (schedule_id) WHERE status = 'running' DO NOTHING
       RETURNING id`,
      [id, input.scheduleId, input.owner, input.scheduledFor, input.startedAt],
    );
    if (inserted.length === 0) {
      throw new ScheduleRunClaimConflictError(input.scheduleId);
    }
    return id;
  }

  /** Update a run to its terminal state, then prune old rows for its schedule. */
  // 実行結果（成功/失敗などの終端状態）で該当行を更新し、続けて保持上限を
  // 超えた古い行を間引く。更新と間引きは別クエリだが、常にセットで呼ばれる。
  async finish(runId: string, scheduleId: string, input: FinishRunInput): Promise<void> {
    await this.db.run(
      `UPDATE schedule_runs SET
         status = $1, attempt = $2, trino_query_id = $3, error_type = $4, error_message = $5,
         row_count = $6, elapsed_ms = $7, finished_at = $8
       WHERE id = $9`,
      [
        input.status,
        input.attempt,
        input.trinoQueryId ?? null,
        input.errorType ?? null,
        input.errorMessage ?? null,
        input.rowCount ?? null,
        input.elapsedMs ?? null,
        input.finishedAt,
        runId,
      ],
    );
    await this.prune(scheduleId);
  }

  /** Most recent runs for a schedule, newest first. */
  // 指定スケジュールの実行履歴を新しい順（started_at 降順、同時刻は id 降順）に
  // 最大 limit 件返す。
  async list(scheduleId: string, limit: number): Promise<ScheduleRunRecord[]> {
    const rows = await this.db.query<ScheduleRunRow>(
      `SELECT * FROM schedule_runs WHERE schedule_id = $1
       ORDER BY started_at DESC, id DESC LIMIT $2`,
      [scheduleId, limit],
    );
    return rows.map(rowToRun);
  }

  /** The single most recent run for a schedule, or undefined. */
  // list() を limit=1 で呼び出す薄いラッパー。
  async latest(scheduleId: string): Promise<ScheduleRunRecord | undefined> {
    const rows = await this.list(scheduleId, 1);
    return rows[0];
  }

  /** 複数スケジュールそれぞれの直近 run を500 idごとのクエリで取得する。 */
  async latestMany(scheduleIds: readonly string[]): Promise<Map<string, ScheduleRunRecord>> {
    if (scheduleIds.length === 0) return new Map();
    const result = new Map<string, ScheduleRunRecord>();
    for (let offset = 0; offset < scheduleIds.length; offset += SQL_ID_CHUNK_SIZE) {
      const chunk = scheduleIds.slice(offset, offset + SQL_ID_CHUNK_SIZE);
      const placeholders = chunk.map((_, index) => `$${index + 1}`).join(', ');
      const rows = await this.db.query<ScheduleRunRow>(
        `SELECT * FROM (
           SELECT schedule_runs.*,
                  ROW_NUMBER() OVER (
                    PARTITION BY schedule_id ORDER BY started_at DESC, id DESC
                  ) AS run_rank
           FROM schedule_runs
           WHERE schedule_id IN (${placeholders})
         ) ranked
         WHERE run_rank = 1`,
        chunk,
      );
      for (const row of rows) result.set(row.schedule_id, rowToRun(row));
    }
    return result;
  }

  // 同一スケジュールの多重実行を防ぐためのチェックに使われる想定。
  async hasRunning(scheduleId: string): Promise<boolean> {
    const rows = await this.db.query<{ id: string }>(
      "SELECT id FROM schedule_runs WHERE schedule_id = $1 AND status = 'running' LIMIT 1",
      [scheduleId],
    );
    return rows.length > 0;
  }

  /**
   * クラッシュリカバリ用。前回プロセスが実行途中で異常終了して `running` の
   * まま残った行を、プロセス起動時などに一括で `aborted` へ遷移させる。
   * 更新した行数を返す。
   */
  async abortOrphans(finishedAt: string): Promise<number> {
    const rows = await this.db.query<{ id: string }>(
      "UPDATE schedule_runs SET status = 'aborted', finished_at = $1 WHERE status = 'running' RETURNING id",
      [finishedAt],
    );
    return rows.length;
  }

  /**
   * 指定スケジュールについて最新 `retention` 件のみを残し、それより古い行を
   * 削除する。サブクエリで「残すべき id」を選び、`NOT IN` でそれ以外を消す
   * 方式のため、保持件数を超えた行だけを削除できる。
   */
  private async prune(scheduleId: string): Promise<void> {
    if (this.retention <= 0) return;
    await this.db.run(
      `DELETE FROM schedule_runs
       WHERE schedule_id = $1
         AND id NOT IN (
           SELECT id FROM schedule_runs WHERE schedule_id = $2
           ORDER BY started_at DESC, id DESC LIMIT $3
         )`,
      [scheduleId, scheduleId, this.retention],
    );
  }
}
