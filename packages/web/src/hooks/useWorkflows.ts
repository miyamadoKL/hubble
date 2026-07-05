// クエリワークフロー機能向けの TanStack Query hooks 一式。
// ワークフローの一覧/単体取得、作成、更新、削除、手動実行、run 詳細の取得を
// ../api/workflows の API 関数を呼び出す形でラップする。
// run 詳細は status が running の間だけ短い間隔でポーリングし、ワークフロー
// キャンバス上のノード状態 (成功/失敗/実行中) をライブ更新する。

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type {
  CreateWorkflowRequest,
  UpdateWorkflowRequest,
  Workflow,
  WorkflowRun,
  WorkflowRunSummary,
} from '@hubble/contracts';
import {
  createWorkflow,
  deleteWorkflow,
  getWorkflow,
  getWorkflowRun,
  listWorkflowRuns,
  listWorkflows,
  runWorkflowNow,
  updateWorkflow,
} from '../api/workflows';

// ワークフロー一覧のキャッシュキー。
const workflowsKey = ['workflows', 'list'] as const;
// 単一ワークフローのキャッシュキー。
const workflowKey = (id: string) => ['workflows', 'detail', id] as const;
// run 一覧のキャッシュキー。
const runsKey = (id: string) => ['workflows', 'runs', id] as const;
// run 詳細のキャッシュキー。
const runDetailKey = (runId: string) => ['workflows', 'run', runId] as const;

/** 一覧のポーリング間隔。パネル表示中に running な lastRun の完了を反映する。 */
const LIST_REFETCH_MS = 15_000;
/** run 詳細のポーリング間隔。実行中のノード状態をライブ更新する。 */
const RUN_ACTIVE_REFETCH_MS = 1_500;

/**
 * ワークフロー一覧を取得する hook。パネル表示中は 15 秒間隔でポーリングする。
 * @param enabled false でクエリとポーリングを無効化する。
 */
export function useWorkflows(enabled = true): UseQueryResult<Workflow[]> {
  return useQuery({
    queryKey: workflowsKey,
    queryFn: () => listWorkflows(),
    enabled,
    refetchInterval: enabled ? LIST_REFETCH_MS : false,
    refetchOnMount: 'always',
  });
}

/**
 * 単一ワークフローを取得する hook。
 * @param id 対象 id。null の場合 (新規作成ビューなど) はクエリを無効化する。
 */
export function useWorkflow(id: string | null): UseQueryResult<Workflow> {
  return useQuery({
    queryKey: workflowKey(id ?? ''),
    queryFn: () => getWorkflow(id!),
    enabled: id !== null,
    refetchOnMount: 'always',
  });
}

/**
 * 指定ワークフローの run サマリ一覧を取得する hook (実行履歴モーダル用)。
 * @param id 対象のワークフロー id。null で無効化。
 * @param limit 取得件数上限。
 */
export function useWorkflowRuns(
  id: string | null,
  limit = 50,
): UseQueryResult<WorkflowRunSummary[]> {
  return useQuery({
    queryKey: runsKey(id ?? ''),
    queryFn: () => listWorkflowRuns(id!, limit),
    enabled: id !== null,
    refetchOnMount: 'always',
  });
}

/**
 * run 詳細 (ステップ状態込み) を取得する hook。
 * status が running の間は 1.5 秒間隔でポーリングし、キャンバスのノード状態を更新する。
 * @param runId 対象の run id。null で無効化。
 */
export function useWorkflowRun(runId: string | null): UseQueryResult<WorkflowRun> {
  return useQuery({
    queryKey: runDetailKey(runId ?? ''),
    queryFn: () => getWorkflowRun(runId!),
    enabled: runId !== null,
    // 実行中だけポーリングし、終端状態に達したら止める。
    refetchInterval: (query) => {
      const data = query.state.data as WorkflowRun | undefined;
      return data?.status === 'running' ? RUN_ACTIVE_REFETCH_MS : false;
    },
    refetchOnMount: 'always',
  });
}

/** 一覧と (id 指定時は) 単体/実行履歴のキャッシュをまとめて無効化する内部ヘルパー。 */
function useWorkflowInvalidation() {
  const client = useQueryClient();
  return (id?: string) => {
    void client.invalidateQueries({ queryKey: workflowsKey });
    if (id) {
      void client.invalidateQueries({ queryKey: workflowKey(id) });
      void client.invalidateQueries({ queryKey: runsKey(id) });
    }
  };
}

/** 新規ワークフローを作成する mutation hook。成功時に一覧を無効化する。 */
export function useCreateWorkflow() {
  const invalidate = useWorkflowInvalidation();
  return useMutation({
    mutationFn: (body: CreateWorkflowRequest) => createWorkflow(body),
    onSuccess: () => invalidate(),
  });
}

/** 既存ワークフローを更新する mutation hook。成功時に一覧と単体を無効化する。 */
export function useUpdateWorkflow() {
  const invalidate = useWorkflowInvalidation();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateWorkflowRequest }) =>
      updateWorkflow(id, body),
    onSuccess: (_data, vars) => invalidate(vars.id),
  });
}

/** ワークフローを削除する mutation hook。成功時に一覧を無効化する。 */
export function useDeleteWorkflow() {
  const invalidate = useWorkflowInvalidation();
  return useMutation({
    mutationFn: (id: string) => deleteWorkflow(id),
    onSuccess: () => invalidate(),
  });
}

/** ワークフローを手動実行する mutation hook。成功時に一覧と実行履歴を無効化する。 */
export function useRunWorkflowNow() {
  const invalidate = useWorkflowInvalidation();
  return useMutation({
    mutationFn: (id: string) => runWorkflowNow(id),
    onSuccess: (_runId, id) => invalidate(id),
  });
}
