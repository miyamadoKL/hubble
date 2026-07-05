import { z } from 'zod';
import { isoTimestamp } from './common';
import { queryColumnSchema } from './query';
import { cronExpression, retryPolicySchema } from './schedule';

/**
 * クエリワークフロー機能の契約を定義するファイル。
 *
 * ワークフローは順序付きステージ列であり、各ステージは複数ステップを並行実行する。
 * 前ステージの全ステップが完了したら次ステージへ進む。ステップ失敗時の挙動は
 * onFailure (stop / continue) で制御する。cron による定期実行と手動実行に対応する。
 */

/** ステップ失敗時のポリシー。stop は以降を中止、continue は次ステージへ進む。 */
export const workflowStepOnFailureSchema = z.enum(['stop', 'continue']);
export type WorkflowStepOnFailure = z.infer<typeof workflowStepOnFailureSchema>;

/** ワークフロー内の 1 ステップ定義。 */
export const workflowStepSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  statement: z.string().min(1),
  datasourceId: z.string().optional(),
  catalog: z.string().optional(),
  schema: z.string().optional(),
  onFailure: workflowStepOnFailureSchema.default('stop'),
});
export type WorkflowStep = z.infer<typeof workflowStepSchema>;

/** 1 ステージ (並行実行するステップの集合)。 */
export const workflowStageSchema = z.object({
  steps: z.array(workflowStepSchema).min(1).max(8),
});
export type WorkflowStage = z.infer<typeof workflowStageSchema>;

/** ワークフロー本体の stages 配列。全ステップ数と step id 重複を検証する。 */
export const workflowDefinitionSchema = z
  .array(workflowStageSchema)
  .min(1)
  .max(10)
  .superRefine((stages, ctx) => {
    const ids = new Set<string>();
    let totalSteps = 0;
    for (const stage of stages) {
      totalSteps += stage.steps.length;
      for (const step of stage.steps) {
        if (ids.has(step.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Duplicate step id: ${step.id}`,
            path: [],
          });
          return;
        }
        ids.add(step.id);
      }
    }
    if (totalSteps > 40) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Total step count must be at most 40',
        path: [],
      });
    }
  });
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

/** ワークフロー実行の終端ステータス。 */
export const workflowRunStatusSchema = z.enum([
  'running',
  'success',
  'partial',
  'failed',
  'aborted',
]);
export type WorkflowRunStatus = z.infer<typeof workflowRunStatusSchema>;

/** ワークフローステップ実行のステータス。 */
export const workflowStepRunStatusSchema = z.enum([
  'pending',
  'running',
  'success',
  'failed',
  'blocked',
  'skipped',
  'aborted',
]);
export type WorkflowStepRunStatus = z.infer<typeof workflowStepRunStatusSchema>;

/** ワークフロー実行サマリ (一覧や lastRun 用)。 */
export const workflowRunSummarySchema = z.object({
  id: z.string().min(1),
  status: workflowRunStatusSchema,
  trigger: z.enum(['manual', 'cron']),
  scheduledFor: isoTimestamp,
  startedAt: isoTimestamp,
  finishedAt: isoTimestamp.nullable(),
  elapsedMs: z.number().int().nonnegative().nullable(),
  stepCounts: z.object({
    total: z.number().int().nonnegative(),
    success: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  }),
});
export type WorkflowRunSummary = z.infer<typeof workflowRunSummarySchema>;

/** 1 ステップの実行記録。 */
export const workflowStepRunSchema = z.object({
  id: z.string().min(1),
  stepId: z.string().min(1),
  stageIndex: z.number().int().nonnegative(),
  name: z.string().min(1),
  datasourceId: z.string().min(1),
  status: workflowStepRunStatusSchema,
  attempt: z.number().int().nonnegative(),
  rowCount: z.number().int().nonnegative().nullable(),
  elapsedMs: z.number().int().nonnegative().nullable(),
  errorType: z.string().nullable(),
  errorMessage: z.string().nullable(),
  resultAvailable: z.boolean(),
  startedAt: isoTimestamp.nullable(),
  finishedAt: isoTimestamp.nullable(),
});
export type WorkflowStepRun = z.infer<typeof workflowStepRunSchema>;

/** ワークフロー実行の詳細 (steps 込み)。 */
export const workflowRunSchema = workflowRunSummarySchema.extend({
  workflowId: z.string().min(1),
  steps: z.array(workflowStepRunSchema),
});
export type WorkflowRun = z.infer<typeof workflowRunSchema>;

/** ワークフロー本体。 */
export const workflowSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(200),
  description: z.string(),
  stages: workflowDefinitionSchema,
  datasourceId: z.string().min(1),
  cron: cronExpression.nullable(),
  enabled: z.boolean(),
  retry: retryPolicySchema,
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
  nextRunAt: isoTimestamp.nullable(),
  lastRun: workflowRunSummarySchema.nullable(),
});
export type Workflow = z.infer<typeof workflowSchema>;

/** POST /api/workflows のリクエストボディ。 */
export const createWorkflowRequestSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  stages: workflowDefinitionSchema,
  datasourceId: z.string().optional(),
  cron: cronExpression.nullable().optional(),
  enabled: z.boolean().optional(),
  retry: retryPolicySchema.optional(),
});
export type CreateWorkflowRequest = z.infer<typeof createWorkflowRequestSchema>;

/** PATCH /api/workflows/:id のリクエストボディ (部分更新)。 */
export const updateWorkflowRequestSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().optional(),
    stages: workflowDefinitionSchema.optional(),
    datasourceId: z.string().optional(),
    cron: cronExpression.nullable().optional(),
    enabled: z.boolean().optional(),
    retry: retryPolicySchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });
export type UpdateWorkflowRequest = z.infer<typeof updateWorkflowRequestSchema>;

/** GET /api/workflows/:id/runs のレスポンス。 */
export const workflowRunsResponseSchema = z.object({
  items: z.array(workflowRunSummarySchema),
});
export type WorkflowRunsResponse = z.infer<typeof workflowRunsResponseSchema>;

/** 保存済みステップ結果の 1 ページ。 */
export const workflowStepResultPageSchema = z.object({
  columns: z.array(queryColumnSchema),
  rows: z.array(z.array(z.unknown())),
  totalRows: z.number().int().nonnegative(),
});
export type WorkflowStepResultPage = z.infer<typeof workflowStepResultPageSchema>;
