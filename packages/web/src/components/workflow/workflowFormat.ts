/**
 * クエリワークフロー UI で使う純粋関数群。
 * 実行ステータスの表示トーン/ラベル、次回実行の相対表示、編集ドラフトの
 * 生成/差分判定/保存可否の判定を提供する。表示コンポーネントから分離して
 * 単体テスト可能にしている。
 */
import type {
  CreateWorkflowRequest,
  UpdateWorkflowRequest,
  Workflow,
  WorkflowRunStatus,
  WorkflowStep,
  WorkflowStepRunStatus,
} from '@hubble/contracts';

/** バッジやノード枠の色分けに使う表示トーン。 */
export type WorkflowTone = 'running' | 'success' | 'error' | 'warning' | 'neutral';

/** run 全体のステータスを表示トーンへ変換する。 */
export function runStatusTone(status: WorkflowRunStatus): WorkflowTone {
  switch (status) {
    case 'running':
      return 'running';
    case 'success':
      return 'success';
    case 'failed':
      return 'error';
    case 'partial':
      return 'warning';
    case 'aborted':
      return 'neutral';
  }
}

/** run 全体のステータスの表示ラベル。 */
export function runStatusLabel(status: WorkflowRunStatus): string {
  return status;
}

/** ステップのステータスを表示トーンへ変換する。 */
export function stepStatusTone(status: WorkflowStepRunStatus): WorkflowTone {
  switch (status) {
    case 'running':
      return 'running';
    case 'success':
      return 'success';
    case 'failed':
    case 'blocked':
      return 'error';
    case 'pending':
    case 'skipped':
    case 'aborted':
      return 'neutral';
  }
}

/**
 * 次回実行予定を相対表示に変換する。cron 未設定は 'manual only'、
 * 無効化中は 'Disabled'、時刻到来済みは 'due now'。
 */
export function nextRunLabel(workflow: Workflow, now: Date): string {
  if (!workflow.cron) return 'manual only';
  if (!workflow.enabled) return 'Disabled';
  if (!workflow.nextRunAt) return '—';
  const diffMs = new Date(workflow.nextRunAt).getTime() - now.getTime();
  if (Number.isNaN(diffMs)) return '—';
  if (diffMs <= 0) return 'due now';
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return 'in <1m';
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

/** ワークフロー編集画面のローカルドラフト。保存時に create/update リクエストへ変換する。 */
export interface WorkflowDraft {
  name: string;
  description: string;
  datasourceId: string;
  cron: string | null;
  enabled: boolean;
  stages: { steps: WorkflowStep[] }[];
}

/** ステップ id を採番する (`st_` プレフィックス + ランダム)。 */
export function newStepId(): string {
  return `st_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

/** 空のステップ定義を 1 件生成する (name/statement は編集モーダルで入力させる)。 */
export function blankStep(): WorkflowStep {
  return { id: newStepId(), name: '', statement: '', onFailure: 'stop' };
}

/** 新規作成用の初期ドラフト。1 ステージ 0 ステップから始める。 */
export function blankDraft(datasourceId: string): WorkflowDraft {
  return {
    name: '',
    description: '',
    datasourceId,
    cron: null,
    enabled: true,
    stages: [{ steps: [] }],
  };
}

/** サーバー取得済みワークフローから編集ドラフトを作る (deep copy)。 */
export function draftFromWorkflow(workflow: Workflow): WorkflowDraft {
  return {
    name: workflow.name,
    description: workflow.description,
    datasourceId: workflow.datasourceId,
    cron: workflow.cron,
    enabled: workflow.enabled,
    stages: workflow.stages.map((stage) => ({ steps: stage.steps.map((step) => ({ ...step })) })),
  };
}

// ドラフトの比較用正規化。JSON 化して構造ごと比較する (ステップ順も含めた完全一致)。
function normalize(draft: WorkflowDraft): string {
  return JSON.stringify(draft);
}

/** 2 つのドラフトが等しいか (dirty 判定)。 */
export function draftEquals(a: WorkflowDraft, b: WorkflowDraft): boolean {
  return normalize(a) === normalize(b);
}

/**
 * ドラフトが保存可能かを検証し、不備があれば理由を返す。
 * @returns null なら保存可能。文字列はユーザー向けの不備メッセージ。
 */
export function draftProblem(draft: WorkflowDraft): string | null {
  if (draft.name.trim() === '') return 'Give the workflow a name.';
  const stages = draft.stages.filter((stage) => stage.steps.length > 0);
  if (stages.length === 0) return 'Add at least one step.';
  for (const stage of draft.stages) {
    for (const step of stage.steps) {
      if (step.name.trim() === '' || step.statement.trim() === '') {
        return `Step "${step.name.trim() || 'untitled'}" needs a name and a SQL statement.`;
      }
    }
  }
  return null;
}

// 空ステージを除去した保存用 stages を返す (draftProblem 通過後に呼ぶ)。
function stagesForSave(draft: WorkflowDraft): WorkflowDraft['stages'] {
  return draft.stages.filter((stage) => stage.steps.length > 0);
}

/** ドラフトを新規作成リクエストへ変換する。 */
export function draftToCreateRequest(draft: WorkflowDraft): CreateWorkflowRequest {
  return {
    name: draft.name.trim(),
    description: draft.description,
    stages: stagesForSave(draft),
    datasourceId: draft.datasourceId,
    cron: draft.cron,
    enabled: draft.enabled,
  };
}

/** ドラフトを部分更新リクエストへ変換する (可変フィールドを全量送る)。 */
export function draftToUpdateRequest(draft: WorkflowDraft): UpdateWorkflowRequest {
  return {
    name: draft.name.trim(),
    description: draft.description,
    stages: stagesForSave(draft),
    datasourceId: draft.datasourceId,
    cron: draft.cron,
    enabled: draft.enabled,
  };
}

/** ドラフト内の総ステップ数。 */
export function totalSteps(draft: WorkflowDraft): number {
  return draft.stages.reduce((sum, stage) => sum + stage.steps.length, 0);
}
