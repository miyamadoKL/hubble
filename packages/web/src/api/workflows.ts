// クエリワークフロー (Query Workflow 機能) の CRUD 操作、手動実行、run 詳細と
// ステップ結果の取得を行うための API クライアントファイル。
// 各関数は apiFetch の薄いラッパーであり、レスポンスを @hubble/contracts の
// zod スキーマで検証する。ポーリング間隔やキャッシュ無効化のポリシーは
// hooks/useWorkflows.ts 側が担当し、このファイルには持たせない。

import { z } from 'zod';
import {
  apiRoutes,
  workflowSchema,
  workflowRunSchema,
  workflowRunsResponseSchema,
  workflowStepResultPageSchema,
  type CreateWorkflowRequest,
  type UpdateWorkflowRequest,
  type Workflow,
  type WorkflowRun,
  type WorkflowRunSummary,
  type WorkflowStepResultPage,
} from '@hubble/contracts';
import { apiFetch } from './client';

// 一覧取得レスポンス用のスキーマ。サーバー (workflowRoutes) は配列をそのまま返す。
const workflowListSchema = z.array(workflowSchema);
// 手動実行トリガー時のレスポンス用スキーマ。発行された実行 id のみを含む。
const runResponseSchema = z.object({ runId: z.string().min(1) });
// 削除など成否のみを返す操作向けの共通スキーマ。
const okSchema = z.object({ ok: z.boolean() });

/**
 * `GET /api/workflows` を呼び出し、ワークフロー一覧を取得する。
 * @param query 名前と説明に対する部分一致 (LIKE) 検索文字列。省略時は全件取得。
 * @returns ワークフローの配列 (lastRun と nextRunAt を含む)。
 * @throws {ApiClientError} リクエスト失敗時、またはレスポンスがスキーマに一致しない場合。
 */
export function listWorkflows(query?: string): Promise<Workflow[]> {
  return apiFetch(workflowListSchema, apiRoutes.workflows(), {
    query: query ? { query } : undefined,
  });
}

/**
 * `GET /api/workflows/:id` を呼び出し、単一のワークフローを取得する。
 * @param id 対象のワークフロー id。
 * @returns ワークフロー (stages 定義を含む完全な形)。
 * @throws {ApiClientError} 存在しない id やリクエスト失敗時。
 */
export function getWorkflow(id: string): Promise<Workflow> {
  return apiFetch(workflowSchema, apiRoutes.workflow(id));
}

/**
 * `POST /api/workflows` を呼び出し、新規ワークフローを作成する (201)。
 * 全ステップの SQL はサーバー側で EXPLAIN VALIDATE により検証される。
 * @param body 作成内容 (CreateWorkflowRequest)。
 * @returns 永続化されたワークフロー (サーバー採番の id を含む)。
 * @throws {ApiClientError} ステップのバリデーションエラー (400、details.stepId 付き) など。
 */
export function createWorkflow(body: CreateWorkflowRequest): Promise<Workflow> {
  return apiFetch(workflowSchema, apiRoutes.workflows(), { method: 'POST', body });
}

/**
 * `PATCH /api/workflows/:id` を呼び出し、ワークフローを部分更新する。
 * stages を渡した場合は全置換となり、サーバー側で再検証される。
 * @param id 更新対象の id。
 * @param body 更新内容 (UpdateWorkflowRequest)。
 * @returns 更新後のワークフロー。
 * @throws {ApiClientError} バリデーションエラーとリクエスト失敗時。
 */
export function updateWorkflow(id: string, body: UpdateWorkflowRequest): Promise<Workflow> {
  return apiFetch(workflowSchema, apiRoutes.workflow(id), { method: 'PATCH', body });
}

/**
 * `DELETE /api/workflows/:id` を呼び出し、ワークフローと実行履歴を削除する。
 * @param id 削除対象の id。
 * @returns 削除に成功した場合 true。
 * @throws {ApiClientError} リクエスト失敗時。
 */
export async function deleteWorkflow(id: string): Promise<boolean> {
  const res = await apiFetch(okSchema, apiRoutes.workflow(id), { method: 'DELETE' });
  return res.ok;
}

/**
 * `POST /api/workflows/:id/run` を呼び出し、ワークフローを即時に手動実行する (202)。
 * @param id 実行対象の id。
 * @returns 新しく発行された run の id。
 * @throws {ApiClientError} 既に実行中の場合は 409。
 */
export async function runWorkflowNow(id: string): Promise<string> {
  const res = await apiFetch(runResponseSchema, apiRoutes.workflowRun(id), { method: 'POST' });
  return res.runId;
}

/**
 * `GET /api/workflows/:id/runs` を呼び出し、実行履歴のサマリ一覧を新しい順に取得する。
 * @param id 対象のワークフロー id。
 * @param limit 取得件数の上限。省略時はサーバー既定。
 * @returns run サマリの配列。
 * @throws {ApiClientError} リクエスト失敗時。
 */
export function listWorkflowRuns(id: string, limit?: number): Promise<WorkflowRunSummary[]> {
  return apiFetch(workflowRunsResponseSchema, apiRoutes.workflowRuns(id), {
    query: limit ? { limit } : undefined,
  }).then((r) => r.items);
}

/**
 * `GET /api/workflow-runs/:runId` を呼び出し、ステップ状態を含む run 詳細を取得する。
 * 実行中は UI 側がポーリングしてノード状態を更新する。
 * @param runId 対象の run id。
 * @returns run 詳細 (steps 込み)。
 * @throws {ApiClientError} 存在しない run やリクエスト失敗時。
 */
export function getWorkflowRun(runId: string): Promise<WorkflowRun> {
  return apiFetch(workflowRunSchema, apiRoutes.workflowRunDetail(runId));
}

/**
 * `GET /api/workflow-runs/:runId/steps/:stepRunId/result` を呼び出し、
 * 永続化済みステップ結果の 1 ページを取得する。
 * @param runId 対象の run id。
 * @param stepRunId 対象のステップ run id。
 * @param offset 読み飛ばす行数。
 * @param limit 取得行数の上限 (サーバー上限 1000)。
 * @returns 列メタデータと行データのページ。
 * @throws {ApiClientError} 結果が未永続化または期限切れの場合は 404。
 */
export function getWorkflowStepResult(
  runId: string,
  stepRunId: string,
  offset = 0,
  limit = 100,
): Promise<WorkflowStepResultPage> {
  return apiFetch(workflowStepResultPageSchema, apiRoutes.workflowStepResult(runId, stepRunId), {
    query: { offset, limit },
  });
}
