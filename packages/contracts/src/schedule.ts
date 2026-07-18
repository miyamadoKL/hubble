import { z } from 'zod';
import { isoTimestamp } from './common';
import { MAX_IDENTIFIER_LENGTH, MAX_NAME_LENGTH, MAX_SQL_LENGTH } from './limits';

/**
 * クエリスケジューリング（cron による定期実行）機能の契約を定義するファイル。
 * `Schedule` は cron 式に従って保存済みの SQL 文を定期実行する設定であり、
 * 発火のたびに実行結果を記録した `ScheduleRun` レコードが 1 件作られる
 * （内部でリトライが発生しても、run レコードは 1 firing につき 1 件のまま。
 * 詳細は `RetryPolicy` を参照）。文は作成/更新時、および実行直前の毎回、Trino の
 * `EXPLAIN (TYPE VALIDATE)` で検証されるため、構文的に不正なクエリが
 * 実クラスタでの実行として走ることはない。
 */

/**
 * 1 回のスケジュール実行の終端ステータス。
 * running（実行中）/ success（成功）/ failed（失敗）/ aborted（中断）/
 * blocked（Query Guard によりブロック）のいずれか。
 */
export const scheduleRunStatusSchema = z.enum([
  'running',
  'success',
  'failed',
  'aborted',
  'blocked',
]);
/** run ステータスの推論型。 */
export type ScheduleRunStatus = z.infer<typeof scheduleRunStatusSchema>;

/**
 * 標準的な 5 フィールド cron 式（`分 時 日 月 曜日`）を表す zod スキーマ。
 * ここでは構造的な妥当性のみを検証し、意味的な解析（実際の次回実行時刻の
 * 計算）は server 側で `cron-parser` を使って行う。各フィールドは `*`、
 * 範囲指定（`1-5`）、リスト（`1,15`）、ステップ値などの組み合わせを許容する。
 * この正規表現は明らかに不正な入力を早期に弾き、契約層が「形」の唯一の
 * 正本であり続けるようにするためのもの。
 */
const CRON_FIELD = String.raw`[0-9A-Za-z*/,\-?]+`;
export const cronExpression = z
  .string()
  .trim()
  // 5 フィールドがスペース区切りで並んでいることを検証する正規表現。
  .regex(
    new RegExp(`^${CRON_FIELD}(?:\\s+${CRON_FIELD}){4}$`),
    'Must be a 5-field cron expression (minute hour day-of-month month day-of-week)',
  );

/**
 * スケジュールのリトライポリシー。非決定的な失敗（通信障害や USER_ERROR
 * 以外のエンジン障害）にのみ適用される。決定的な失敗（`EXPLAIN VALIDATE`
 * や実行自体で発生した `USER_ERROR`、Query Guard によるブロック）は
 * 再試行しても同じ結果になるためリトライされない。
 * N 回目のリトライ前の待機時間は `backoffSeconds * backoffMultiplier^(n-1)` で算出される。
 */
export const retryPolicySchema = z.object({
  // 初回実行を含む総試行回数（1 に設定するとリトライが無効になる）。
  maxAttempts: z.number().int().min(1).max(10).default(3),
  // 最初のリトライまでの基本待機時間（秒）。
  backoffSeconds: z.number().int().min(1).max(3600).default(60),
  // 2 回目以降のリトライに適用される幾何級数的なバックオフ倍率。
  backoffMultiplier: z.number().int().min(1).max(10).default(2),
});
/** リトライポリシーの推論型。 */
export type RetryPolicy = z.infer<typeof retryPolicySchema>;

/** リクエストで省略された場合に使われる既定のリトライポリシー。 */
export const defaultRetryPolicy: RetryPolicy = retryPolicySchema.parse({});

/** 通知の送信先チャネル。 */
export const scheduleNotificationChannelSchema = z.enum(['slack', 'email']);
/** 通知の送信先チャネル型。 */
export type ScheduleNotificationChannel = z.infer<typeof scheduleNotificationChannelSchema>;

/**
 * スケジュール失敗時の外部通知設定。
 */
export const scheduleNotificationsSchema = z
  .object({
    // 確定失敗時に通知するかどうか。
    onFailure: z.boolean().default(false),
    // 通知に使うチャネル。
    channels: z
      .array(scheduleNotificationChannelSchema)
      .default([])
      .refine((channels) => new Set(channels).size === channels.length, {
        message: 'Duplicate notification channels are not allowed',
      }),
    // email チャネルの宛先。
    emailTo: z.array(z.string().email()).max(10).optional(),
  })
  .superRefine((notifications, ctx) => {
    if (notifications.channels.includes('email') && (notifications.emailTo?.length ?? 0) === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['emailTo'],
        message: 'emailTo is required when email notifications are enabled',
      });
    }
  });
/** スケジュール通知設定の推論型。 */
export type ScheduleNotifications = z.infer<typeof scheduleNotificationsSchema>;

/** リクエストで省略された場合に使われる通知設定。 */
export const defaultScheduleNotifications: ScheduleNotifications =
  scheduleNotificationsSchema.parse({});

/**
 * 直近実行の簡易サマリ。`Schedule` レスポンスに埋め込んで一覧表示などに使う。
 */
export const scheduleRunSummarySchema = z.object({
  // run の一意な id。
  id: z.string().min(1),
  // 実行の終端ステータス。
  status: scheduleRunStatusSchema,
  // 何回目の試行か（リトライ込みの通し番号）。
  attempt: z.number().int().nonnegative(),
  // Trino 側のクエリ id（実行が Trino に到達した場合のみ設定）。
  trinoQueryId: z.string().nullable(),
  // 失敗時のエラー種別。
  errorType: z.string().nullable(),
  // 失敗時のエラーメッセージ。
  errorMessage: z.string().nullable(),
  // 取得された行数。
  rowCount: z.number().int().nonnegative().nullable(),
  // 実行にかかった時間（ミリ秒）。
  elapsedMs: z.number().int().nonnegative().nullable(),
  // この run が本来発火するはずだった予定時刻（cron による計算値）。
  scheduledFor: isoTimestamp,
  // 実際に実行が開始された日時。
  startedAt: isoTimestamp,
  // 実行が終了した日時（実行中は未設定）。
  finishedAt: isoTimestamp.nullable(),
});
/** run サマリの推論型。 */
export type ScheduleRunSummary = z.infer<typeof scheduleRunSummarySchema>;

/**
 * `GET /api/schedules/:id/runs` が返す run のフルレコード。
 * サマリにどのスケジュールに属する run かを表す scheduleId を加えたもの。
 */
export const scheduleRunSchema = scheduleRunSummarySchema.extend({
  scheduleId: z.string().min(1),
});
/** run フルレコードの推論型。 */
export type ScheduleRun = z.infer<typeof scheduleRunSchema>;

/**
 * スケジュール本体のスキーマ。`nextRunAt` はレスポンス生成時に cron 式から
 * 都度計算される（無効化されている場合や計算不能な場合は null）。
 * `lastRun` は直近実行のサマリを埋め込んだもの。
 */
export const scheduleSchema = z.object({
  // 一意な id。
  id: z.string().min(1),
  // スケジュール名。
  name: z.string(),
  // 実行する SQL 文。
  statement: z.string(),
  // 実行対象のカタログ。
  catalog: z.string().nullable(),
  // 実行対象のスキーマ。
  schema: z.string().nullable(),
  // 実行タイミングを表す cron 式。
  cron: cronExpression,
  // このスケジュールが有効かどうか。
  enabled: z.boolean(),
  // リトライポリシー。
  retry: retryPolicySchema,
  // 確定失敗時の外部通知設定。
  notifications: scheduleNotificationsSchema,
  // 作成日時。
  createdAt: isoTimestamp,
  // 最終更新日時。
  updatedAt: isoTimestamp,
  // 次回発火予定時刻（計算済み）。無効化されている場合や計算不能な場合は null。
  nextRunAt: isoTimestamp.nullable(),
  // 直近の実行サマリ。一度も実行されていない場合は null。
  lastRun: scheduleRunSummarySchema.nullable(),
  // 実行先データソース id（作成/更新時に解決して永続化）。
  datasourceId: z.string(),
});
/** スケジュール全体の推論型。 */
export type Schedule = z.infer<typeof scheduleSchema>;

/** `POST /api/schedules`（新規作成）のリクエストボディ。 */
export const createScheduleRequestSchema = z.object({
  name: z.string().min(1).max(MAX_NAME_LENGTH),
  statement: z.string().min(1).max(MAX_SQL_LENGTH),
  catalog: z.string().max(MAX_IDENTIFIER_LENGTH).optional(),
  schema: z.string().max(MAX_IDENTIFIER_LENGTH).optional(),
  cron: cronExpression.max(MAX_IDENTIFIER_LENGTH),
  // 省略時は有効（enabled=true）として作成される（server 側の既定値に依存）。
  enabled: z.boolean().optional(),
  // 省略時は defaultRetryPolicy が適用される。
  retry: retryPolicySchema.optional(),
  // 省略時は通知しない。
  notifications: scheduleNotificationsSchema.optional(),
  // 実行先データソース id。省略時は作成時に既定データソースを保存する。
  datasourceId: z.string().max(MAX_IDENTIFIER_LENGTH).optional(),
});
/** スケジュール作成リクエストの推論型。 */
export type CreateScheduleRequest = z.infer<typeof createScheduleRequestSchema>;

/**
 * `PATCH /api/schedules/:id` のリクエストボディ。すべてのフィールドが
 * 省略可能で、渡されたフィールドのみが更新される（部分更新）。
 * `statement` / `catalog` / `schema` / `cron` を変更すると、
 * `EXPLAIN (TYPE VALIDATE)` による再検証がトリガーされる。
 */
export const updateScheduleRequestSchema = z
  .object({
    name: z.string().min(1).max(MAX_NAME_LENGTH).optional(),
    statement: z.string().min(1).max(MAX_SQL_LENGTH).optional(),
    catalog: z.string().max(MAX_IDENTIFIER_LENGTH).nullable().optional(),
    schema: z.string().max(MAX_IDENTIFIER_LENGTH).nullable().optional(),
    cron: cronExpression.max(MAX_IDENTIFIER_LENGTH).optional(),
    enabled: z.boolean().optional(),
    retry: retryPolicySchema.optional(),
    notifications: scheduleNotificationsSchema.optional(),
    datasourceId: z.string().max(MAX_IDENTIFIER_LENGTH).optional(),
  })
  // 更新対象フィールドが 1 つも指定されていない空リクエストを拒否する。
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });
/** スケジュール更新リクエストの推論型。 */
export type UpdateScheduleRequest = z.infer<typeof updateScheduleRequestSchema>;

/** `GET /api/schedules/:id/runs` のレスポンス。指定スケジュールの実行履歴一覧を返す。 */
export const scheduleRunsResponseSchema = z.object({
  items: z.array(scheduleRunSchema),
});
/** スケジュール実行履歴レスポンスの推論型。 */
export type ScheduleRunsResponse = z.infer<typeof scheduleRunsResponseSchema>;
