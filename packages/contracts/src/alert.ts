import { z } from 'zod';
import { isoTimestamp } from './common';
import { cronExpression } from './schedule';

/**
 * Alert 機能（保存クエリ結果の閾値監視と通知）の契約を定義するファイル。
 * Alert は cron 式に従って保存済みクエリを実行し、結果の指定カラムを
 * 閾値と比較して state を更新する。通知は state 遷移と rearm 設定に従う。
 */

/** 閾値比較演算子。 */
export const alertOpSchema = z.enum(['>', '>=', '<', '<=', '==', '!=']);
/** 閾値比較演算子型。 */
export type AlertOp = z.infer<typeof alertOpSchema>;

/** 結果行から監視値を取り出す方法。 */
export const alertSelectorSchema = z.enum(['first', 'max', 'min']);
/** 結果行から監視値を取り出す方法の型。 */
export type AlertSelector = z.infer<typeof alertSelectorSchema>;

/** Alert の実行時状態。 */
export const alertStateSchema = z.enum(['unknown', 'ok', 'triggered']);
/** Alert の実行時状態型。 */
export type AlertState = z.infer<typeof alertStateSchema>;

/** 通知の送信先チャネル。 */
export const alertNotificationChannelSchema = z.enum(['slack', 'email', 'webhook']);
/** 通知の送信先チャネル型。 */
export type AlertNotificationChannel = z.infer<typeof alertNotificationChannelSchema>;

/**
 * Alert 発火時の外部通知設定。
 */
export const alertNotificationsSchema = z
  .object({
    channels: z
      .array(alertNotificationChannelSchema)
      .default([])
      .refine((channels) => new Set(channels).size === channels.length, {
        message: 'Duplicate notification channels are not allowed',
      }),
    emailTo: z.array(z.string().email()).max(10).optional(),
    webhookUrl: z.string().url().optional(),
  })
  .superRefine((notifications, ctx) => {
    if (notifications.channels.includes('email') && (notifications.emailTo?.length ?? 0) === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['emailTo'],
        message: 'emailTo is required when email notifications are enabled',
      });
    }
    if (notifications.channels.includes('webhook') && !notifications.webhookUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['webhookUrl'],
        message: 'webhookUrl is required when webhook notifications are enabled',
      });
    }
  });
/** Alert 通知設定の推論型。 */
export type AlertNotifications = z.infer<typeof alertNotificationsSchema>;

/** リクエストで省略された場合に使われる通知設定。 */
export const defaultAlertNotifications: AlertNotifications = alertNotificationsSchema.parse({});

/**
 * Alert 本体のスキーマ。
 * `nextEvalAt` はレスポンス生成時に cron 式から都度計算される。
 */
export const alertSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  savedQueryId: z.string().min(1),
  columnName: z.string().min(1),
  op: alertOpSchema,
  value: z.string(),
  selector: alertSelectorSchema,
  rearm: z.number().int().nonnegative(),
  muted: z.boolean(),
  cron: cronExpression,
  state: alertStateSchema,
  lastTriggeredAt: isoTimestamp.nullable(),
  notifications: alertNotificationsSchema,
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
  /** 次回評価予定時刻（ISO）。mute 時も cron は保持する。 */
  nextEvalAt: isoTimestamp.nullable(),
});
/** Alert 全体の推論型。 */
export type Alert = z.infer<typeof alertSchema>;

/** `POST /api/alerts` のリクエストボディ。 */
export const createAlertRequestSchema = z.object({
  name: z.string().min(1),
  savedQueryId: z.string().min(1),
  columnName: z.string().min(1),
  op: alertOpSchema,
  value: z.string(),
  selector: alertSelectorSchema.default('first'),
  rearm: z.number().int().nonnegative().default(0),
  muted: z.boolean().optional(),
  cron: cronExpression,
  notifications: alertNotificationsSchema.optional(),
});
/** Alert 作成リクエストの推論型。 */
export type CreateAlertRequest = z.infer<typeof createAlertRequestSchema>;

/** `PUT /api/alerts/:id` のリクエストボディ。 */
export const updateAlertRequestSchema = createAlertRequestSchema;
/** Alert 更新リクエストの推論型。 */
export type UpdateAlertRequest = z.infer<typeof updateAlertRequestSchema>;

/** 手動評価 `POST /api/alerts/:id/eval` のレスポンス。 */
export const alertEvalResponseSchema = z.object({
  state: alertStateSchema,
  previousState: alertStateSchema,
  conditionMet: z.boolean(),
  observedValue: z.string().nullable(),
  notified: z.boolean(),
  errorType: z.string().nullable(),
  errorMessage: z.string().nullable(),
});
/** 手動評価レスポンスの推論型。 */
export type AlertEvalResponse = z.infer<typeof alertEvalResponseSchema>;
