/**
 * ワークフロービュー (メインエリア)。
 *
 * ワークフローの定義編集と実行状態の確認を 1 つのキャンバスで行う画面。
 * ステージを左から右への列として描画し (実行順が視覚的に分かる)、ステージ内の
 * ステップは縦に積んだカードで表す。run を選択している間は各カードに
 * 成功/失敗/実行中などの状態が色とアイコンで重ね描きされ、実行中はポーリングで
 * ライブ更新される。ヘッダーは [戻る] [名前] [ステータス] [Runs] [Run] [Save] と
 * 設定/削除だけの最小構成にし、SQL の編集などの詳細はステップカードを
 * クリックして開くモーダルに集約する。
 *
 * 外側の `WorkflowView` がデータ取得と読み込み状態を担当し、編集本体の
 * `WorkflowEditor` は workflowId をキーに再マウントされる。これによりドラフトの
 * 初期化を effect ではなくマウント時の useState 初期値で行える。
 */
import { useMemo, useState } from 'react';
import type { DatasourceSummary, Workflow, WorkflowStep, WorkflowStepRun } from '@hubble/contracts';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  CircleSlash,
  Clock,
  History as HistoryIcon,
  OctagonX,
  Play,
  Plus,
  Save,
  Settings2,
  Table2,
  Trash2,
  TriangleAlert,
  Workflow as WorkflowIcon,
  X,
} from 'lucide-react';
import { Button } from '../common/Button';
import { Spinner } from '../common/Spinner';
import { EmptyState } from '../common/EmptyState';
import { Modal } from '../common/Modal';
import { toast } from '../common/Toast';
import { ApiClientError } from '../../api/client';
import { useUiStore } from '../../stores/uiStore';
import { useDatasources, resolveDatasourceLabel } from '../../hooks/useDatasources';
import { useDocumentGitStatus, useGithubStatus } from '../../hooks/useGithub';
import {
  useWorkflow,
  useCreateWorkflow,
  useUpdateWorkflow,
  useDeleteWorkflow,
  useRunWorkflowNow,
  useWorkflowRun,
} from '../../hooks/useWorkflows';
import { WorkflowStatusBadge } from './WorkflowStatusBadge';
import { GitSyncControl } from '../github/GitSyncControl';
import { RunExportMenu } from './RunExportMenu';
import { StepEditorModal } from './StepEditorModal';
import { WorkflowSettingsModal, type WorkflowSettings } from './WorkflowSettingsModal';
import { WorkflowRunsModal } from './WorkflowRunsModal';
import { StepResultModal } from './StepResultModal';
import {
  blankDraft,
  blankStep,
  draftEquals,
  draftFromWorkflow,
  draftProblem,
  draftToCreateRequest,
  draftToUpdateRequest,
  stepStatusTone,
  totalSteps,
  type WorkflowDraft,
  type WorkflowTone,
} from './workflowFormat';
import { cn } from '../../utils/cn';
import {
  useDocumentNavigationGuard,
  useDocumentNavigationOwner,
} from '../../hooks/useDocumentNavigationGuard';
import {
  continueDocumentNavigation,
  saveActiveDocument,
} from '../../navigation/documentNavigation';
import { useT, type TFn } from '../../i18n/t';
import { useLocale } from '../../i18n/locale';
import { commonMessages } from '../../i18n/messages/common';
import { workflowMessages } from '../../i18n/messages/workflow';
import { formatInt } from '../../utils/format';

/** WorkflowView 内で使う辞書の合成。共通文言 + workflow 固有文言を 1 つの t() で引けるようにする。 */
const workflowViewDict = { ...commonMessages, ...workflowMessages } as const;

// ステップカードの左ボーダーの色 (トーン別)。
const cardToneBorder: Record<WorkflowTone, string> = {
  running: 'border-l-running',
  success: 'border-l-success',
  error: 'border-l-error',
  warning: 'border-l-warning',
  neutral: 'border-l-border-strong',
};

// ステップ編集モーダルの対象。stepIndex が null なら「stageIndex へ新規追加」。
interface StepEditorTarget {
  stageIndex: number;
  stepIndex: number | null;
  step: WorkflowStep;
}

// サーバー保存時に返ったステップ単位のバリデーションエラー。
interface StepValidationError {
  stepId: string | null;
  message: string;
}

/**
 * ステップの実行状態をアイコンで表す。定義編集のみ (run 未選択) の場合は null。
 */
function StepStatusIcon({ stepRun }: { stepRun: WorkflowStepRun | undefined }) {
  if (!stepRun) return null;
  switch (stepRun.status) {
    case 'running':
      return <Spinner size={13} className="text-running" />;
    case 'success':
      return <Check size={14} strokeWidth={2.25} className="text-success" />;
    case 'failed':
      return <X size={14} strokeWidth={2.25} className="text-error" />;
    case 'blocked':
      return <OctagonX size={13} strokeWidth={2} className="text-error" />;
    case 'skipped':
      return <CircleSlash size={13} strokeWidth={2} className="text-ink-subtle" />;
    case 'aborted':
      return <TriangleAlert size={13} strokeWidth={2} className="text-ink-subtle" />;
    case 'pending':
      return <Clock size={13} strokeWidth={2} className="text-ink-subtle" />;
  }
}

/**
 * ステップカード 1 枚を描画する。
 * 定義 (名前、SQL 1 行要約、失敗ポリシー) と、run 選択中はその実行状態
 * (アイコン、行数、所要時間、エラー、結果閲覧ボタン) を重ねて表示する。
 * @param step ステップ定義。
 * @param stepRun 選択中 run におけるこのステップの実行記録 (未選択なら undefined)。
 * @param invalid サーバー保存時にこのステップがバリデーションエラーになったかどうか。
 * @param onEdit カードクリックで編集モーダルを開くコールバック。
 * @param onShowResult 結果閲覧ボタン押下時のコールバック。
 * @param t 呼び出し元 (WorkflowEditor) から渡す翻訳関数。
 */
function StepCard({
  step,
  stepRun,
  invalid,
  onEdit,
  onShowResult,
  t,
}: {
  step: WorkflowStep;
  stepRun: WorkflowStepRun | undefined;
  invalid: boolean;
  onEdit: () => void;
  onShowResult: () => void;
  t: TFn<typeof workflowViewDict>;
}) {
  const tone: WorkflowTone = stepRun ? stepStatusTone(stepRun.status) : 'neutral';
  // SQL の改行を畳んだ 1 行要約。
  const oneLine = step.statement.replace(/\s+/g, ' ').trim();
  return (
    <div
      className={cn(
        'rounded-md border border-l-2 border-border-base bg-surface-raised shadow-sm transition-colors',
        cardToneBorder[tone],
        invalid && 'border-error',
        stepRun?.status === 'skipped' && 'opacity-60',
      )}
    >
      <button type="button" onClick={onEdit} className="w-full px-3 pt-2.5 pb-1.5 text-left">
        <span className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink-strong">
            {step.name || <span className="text-ink-subtle italic">{t('untitledStep')}</span>}
          </span>
          <StepStatusIcon stepRun={stepRun} />
        </span>
        <span className="mt-1 block truncate font-mono text-2xs text-ink-subtle">
          {oneLine || 'SELECT …'}
        </span>
      </button>

      {/* フッター: 失敗ポリシーと run のメトリクス。 */}
      <div className="flex items-center gap-2 px-3 pb-2">
        <span
          className="inline-flex items-center gap-1 font-mono text-2xs text-ink-subtle"
          title={step.onFailure === 'stop' ? t('onFailureStopTitle') : t('onFailureContinueTitle')}
        >
          {step.onFailure === 'stop' ? (
            <OctagonX size={11} strokeWidth={2} />
          ) : (
            <ArrowRight size={11} strokeWidth={2} />
          )}
          {step.onFailure === 'stop' ? t('onFailureStopShort') : t('onFailureContinueShort')}
        </span>
        {stepRun?.rowCount !== null && stepRun?.rowCount !== undefined && (
          <span className="font-mono text-2xs text-ink-subtle">
            {t('rowsCountUnit', { n: formatInt(stepRun.rowCount) })}
          </span>
        )}
        {stepRun?.elapsedMs !== null && stepRun?.elapsedMs !== undefined && (
          <span className="font-mono text-2xs text-ink-subtle">
            {stepRun.elapsedMs < 1000
              ? `${stepRun.elapsedMs}ms`
              : `${(stepRun.elapsedMs / 1000).toFixed(1)}s`}
          </span>
        )}
        {/* 永続化済み結果があれば閲覧ボタンを出す。 */}
        {stepRun?.resultAvailable && (
          <button
            type="button"
            onClick={onShowResult}
            title={t('viewResultTitle')}
            aria-label={t('viewResultAria', { name: step.name })}
            className="ml-auto rounded-sm p-0.5 text-ink-subtle hover:text-accent"
          >
            <Table2 size={13} strokeWidth={2} />
          </button>
        )}
      </div>

      {/* 失敗時はエラーメッセージを 2 行まで表示する (全文は title で確認可能)。 */}
      {stepRun?.errorMessage && (
        <p
          className="mx-3 mb-2 line-clamp-2 border-t border-border-subtle pt-1.5 text-2xs text-error"
          title={stepRun.errorMessage}
        >
          {stepRun.errorMessage}
        </p>
      )}
    </div>
  );
}

/**
 * ワークフロービューの外殻。uiStore の workflowView (開いている id または新規作成) を
 * 読み、既存ワークフローの取得と読み込み/エラー表示を担当する。データが揃ったら
 * workflowId をキーに WorkflowEditor を再マウントする。
 */
export function WorkflowView() {
  const t = useT(workflowViewDict);
  const view = useUiStore((s) => s.workflowView);
  const closeWorkflow = useUiStore((s) => s.closeWorkflow);
  const { datasources, selectedId: shellDatasourceId } = useDatasources();

  const workflowId = view?.kind === 'workflow' ? view.id : null;
  const isNew = view?.kind === 'new-workflow';
  const workflowQuery = useWorkflow(workflowId);

  if (!view) return null;

  // 既存ワークフローの読み込み中/失敗時の表示。
  if (!isNew && workflowQuery.isPending) {
    return (
      <div className="flex h-full items-center justify-center gap-2 font-mono text-2xs text-ink-subtle">
        <Spinner size={14} /> {t('loadingWorkflow')}
      </div>
    );
  }
  if (!isNew && workflowQuery.isError) {
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState
          icon={WorkflowIcon}
          title={t('couldntLoadWorkflowTitle')}
          description={t('mayHaveBeenDeleted')}
          action={
            <Button variant="default" size="sm" icon={ArrowLeft} onClick={closeWorkflow}>
              {t('backToNotebooks')}
            </Button>
          }
        />
      </div>
    );
  }

  const workflow = isNew ? null : (workflowQuery.data ?? null);
  if (!isNew && !workflow) return null;

  return (
    <WorkflowEditor
      // id または updatedAt が変わったら (別ワークフローを開いた、新規→保存済みへ遷移した、
      // GitHub pull などサーバー側で内容が更新された) 再マウントしてドラフトを初期化し直す。
      key={workflowId ? `${workflowId}:${workflow?.updatedAt ?? ''}` : 'new'}
      workflowId={workflowId}
      workflow={workflow}
      datasources={datasources}
      fallbackDatasourceId={shellDatasourceId ?? datasources[0]?.id ?? ''}
    />
  );
}

/**
 * ワークフロー編集/実行ビューの本体。マウント時にドラフトを初期化し、以後の
 * 編集、保存、実行、run 表示を統括する。workflowId が変わる場合は親が key で
 * 再マウントする前提のため、同期用の effect を持たない。
 * @param workflowId 編集対象の id。新規作成中は null。
 * @param workflow サーバー取得済みのワークフロー。新規作成中は null。
 * @param datasources データソース一覧 (セレクトとバッジ表示用)。
 * @param fallbackDatasourceId 新規作成時の既定 datasource id。
 */
function WorkflowEditor({
  workflowId,
  workflow,
  datasources,
  fallbackDatasourceId,
}: {
  workflowId: string | null;
  workflow: Workflow | null;
  datasources: DatasourceSummary[];
  fallbackDatasourceId: string;
}) {
  const t = useT(workflowViewDict);
  const { locale } = useLocale();
  const openWorkflow = useUiStore((s) => s.openWorkflow);
  const closeWorkflow = useUiStore((s) => s.closeWorkflow);
  const isNew = workflowId === null;

  // 編集ドラフトと、dirty 判定の基準となるベースライン。マウント時に一度だけ初期化する。
  const [draft, setDraft] = useState<WorkflowDraft>(() =>
    workflow ? draftFromWorkflow(workflow) : blankDraft(fallbackDatasourceId),
  );
  const [baseline, setBaseline] = useState<WorkflowDraft>(draft);
  // キャンバスに状態を重ねる対象の run id。初期値は直近 run。
  const [selectedRunId, setSelectedRunId] = useState<string | null>(
    () => workflow?.lastRun?.id ?? null,
  );
  // 各モーダルの開閉状態。
  const [stepEditor, setStepEditor] = useState<StepEditorTarget | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [runsOpen, setRunsOpen] = useState(false);
  const [resultFor, setResultFor] = useState<{ stepRunId: string; name: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // サーバー保存時のステップ単位バリデーションエラー。
  const [stepError, setStepError] = useState<StepValidationError | null>(null);

  const create = useCreateWorkflow();
  const update = useUpdateWorkflow();
  const remove = useDeleteWorkflow();
  const runNow = useRunWorkflowNow();
  const runQuery = useWorkflowRun(selectedRunId);
  const navigationOwner = useDocumentNavigationOwner();
  // ガバナンス強制 (GITHUB_GOVERNANCE=on) 時の注意表示用。承認済みでない
  // ワークフローは cron 実行がブロックされ、結果も永続化されない。
  const githubStatus = useGithubStatus();
  const gitDocStatus = useDocumentGitStatus(
    'workflow',
    workflowId,
    githubStatus.data?.enabled ?? false,
  );
  const governanceBlocked =
    githubStatus.data?.governance === 'on' &&
    gitDocStatus.data !== undefined &&
    gitDocStatus.data.status !== 'approved';

  const dirty = !draftEquals(draft, baseline);

  // 選択中 run のステップ状態を stepId で引ける Map にする。
  const stepRunById = useMemo(() => {
    const map = new Map<string, WorkflowStepRun>();
    const run = runQuery.data;
    if (run && (workflowId === null || run.workflowId === workflowId)) {
      for (const stepRun of run.steps) map.set(stepRun.stepId, stepRun);
    }
    return map;
  }, [runQuery.data, workflowId]);

  const runInFlight = runQuery.data?.status === 'running';
  const problem = draftProblem(draft, locale);
  const saving = create.isPending || update.isPending;
  // 一括エクスポートは、選択中 run が完了済みで、永続化済み結果を持つ成功ステップが
  // 1 つでもあるときだけ出す (RESULT_STORE 無効環境では出ない)。
  const exportableRun =
    runQuery.data &&
    runQuery.data.status !== 'running' &&
    runQuery.data.steps.some((s) => s.status === 'success' && s.resultAvailable)
      ? runQuery.data.id
      : null;

  // ドラフト更新のショートハンド (バリデーションエラー表示もリセットする)。
  const patchDraft = (patch: Partial<WorkflowDraft>) => {
    setStepError(null);
    setDraft((cur) => ({ ...cur, ...patch }));
  };

  // ステップ編集モーダルの確定処理 (新規追加または置換)。
  const applyStep = (target: StepEditorTarget, step: WorkflowStep) => {
    setStepError(null);
    setDraft((cur) => {
      const stages = cur.stages.map((stage) => ({ steps: [...stage.steps] }));
      const stage = stages[target.stageIndex];
      if (!stage) return cur;
      if (target.stepIndex === null) stage.steps.push(step);
      else stage.steps[target.stepIndex] = step;
      return { ...cur, stages };
    });
    setStepEditor(null);
  };

  // ステップの削除。ステージが空になっても残す (Save 時に空ステージは除外される)。
  const removeStep = (target: StepEditorTarget) => {
    setStepError(null);
    setDraft((cur) => {
      if (target.stepIndex === null) return cur;
      const stages = cur.stages.map((stage) => ({ steps: [...stage.steps] }));
      stages[target.stageIndex]!.steps.splice(target.stepIndex, 1);
      return { ...cur, stages };
    });
    setStepEditor(null);
  };

  // 空ステージを取り除く (空ステージの "Remove stage" 用)。
  const removeEmptyStage = (stageIndex: number) => {
    setDraft((cur) => {
      const stages = cur.stages.filter((stage, i) => i !== stageIndex || stage.steps.length > 0);
      return { ...cur, stages: stages.length > 0 ? stages : [{ steps: [] }] };
    });
  };

  // サーバーエラーからステップ単位のバリデーション情報を取り出す。
  const captureServerError = (error: unknown) => {
    if (error instanceof ApiClientError) {
      const details = error.detail.details as { stepId?: string; message?: string } | undefined;
      setStepError({
        stepId: typeof details?.stepId === 'string' ? details.stepId : null,
        message: details?.message ?? error.detail.message,
      });
      toast.error(t('saveFailedToastTitle'), details?.message ?? error.detail.message);
    } else {
      toast.error(t('saveFailedToastTitle'), t('couldNotReachServer'));
    }
  };

  // 保存 (新規作成または更新)。成功時はベースラインを更新して dirty を解消する。
  const save = async (): Promise<void> => {
    if (problem || (!dirty && !isNew)) return;
    setStepError(null);
    try {
      if (isNew) {
        const created = await create.mutateAsync(draftToCreateRequest(draft));
        toast.success(t('workflowCreatedToast'), t('workflowReadyToRun', { name: created.name }));
        // 保存済み id で開き直す (key が変わり、サーバー確定値で再マウントされる)。
        continueDocumentNavigation(navigationOwner, () => openWorkflow(created.id));
        return;
      }
      const updated = await update.mutateAsync({
        id: workflowId,
        body: draftToUpdateRequest(draft),
      });
      const next = draftFromWorkflow(updated);
      setDraft(next);
      setBaseline(next);
      toast.success(t('workflowSavedToast'), t('entitySavedBody', { name: updated.name }));
    } catch (error) {
      captureServerError(error);
    }
  };

  useDocumentNavigationGuard(
    {
      label: draft.name.trim() || t('untitledWorkflow'),
      dirty,
      save,
    },
    navigationOwner,
  );

  // 手動実行。開始した run をそのままキャンバスの表示対象にする。
  const run = () => {
    if (isNew) return;
    runNow.mutate(workflowId, {
      onSuccess: (runId) => {
        setSelectedRunId(runId);
        toast.info(t('runStartedToast'), t('workflowIsRunning', { name: draft.name }));
      },
      onError: (error) => {
        if (error instanceof ApiClientError && error.status === 409) {
          toast.error(t('alreadyRunningToast'), t('alreadyRunningDescription'));
        } else {
          toast.error(t('runFailedTitle'), t('couldNotStartRun'));
        }
      },
    });
  };

  const defaultDatasourceLabel = resolveDatasourceLabel(datasources, draft.datasourceId);

  return (
    <div className="flex h-full flex-col">
      {/* ヘッダー: 戻る、名前 (インライン編集)、run ステータス、主要アクション。 */}
      <header className="flex flex-wrap items-center gap-2 border-b border-border-subtle px-4 py-2.5">
        <Button
          variant="ghost"
          size="sm"
          icon={ArrowLeft}
          onClick={closeWorkflow}
          aria-label={t('backToNotebooks')}
        />
        <input
          value={draft.name}
          onChange={(e) => patchDraft({ name: e.target.value })}
          placeholder={t('untitledWorkflow')}
          aria-label={t('workflowNameAria')}
          className="w-56 min-w-0 bg-transparent text-base font-semibold text-ink-strong placeholder:text-ink-subtle focus:outline-none"
        />
        {runQuery.data && <WorkflowStatusBadge status={runQuery.data.status} />}
        {/* GitHub 連携ステータス (連携有効時のみ表示、クリックで同期モーダル)。 */}
        <GitSyncControl type="workflow" id={workflowId} documentName={draft.name} />

        <div className="ml-auto flex items-center gap-1.5">
          {/* dirty のときは Run より Save を促す (実行は保存済み定義に対して行われるため)。 */}
          {(dirty || isNew) && (
            <span className="mr-1 font-mono text-2xs text-warning">{t('unsavedChanges')}</span>
          )}
          {/* 選択中 run の結果一括エクスポート (CSV zip / xlsx / Google Sheets)。 */}
          {exportableRun && <RunExportMenu runId={exportableRun} disabled={false} />}
          <Button
            variant="ghost"
            size="sm"
            icon={HistoryIcon}
            onClick={() => setRunsOpen(true)}
            disabled={isNew}
          >
            {t('runsLabel')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={Settings2}
            onClick={() => setSettingsOpen(true)}
            aria-label={t('workflowSettingsTitle')}
          />
          <Button
            variant="ghost"
            size="sm"
            icon={Trash2}
            onClick={() => setConfirmDelete(true)}
            disabled={isNew}
            aria-label={t('deleteWorkflowAria')}
            className="text-ink-subtle hover:text-error"
          />
          <Button
            variant="default"
            size="sm"
            icon={Save}
            onClick={() => void saveActiveDocument()}
            disabled={saving || (!dirty && !isNew)}
            title={problem ?? undefined}
          >
            {saving ? t('savingButton') : t('saveButton')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            icon={Play}
            onClick={run}
            disabled={isNew || dirty || runInFlight || runNow.isPending}
            title={isNew || dirty ? t('saveBeforeRunningTitle') : t('runAllStagesTitle')}
          >
            {runInFlight ? t('runningEllipsis') : t('runButton')}
          </Button>
        </div>
      </header>

      {/* ガバナンス強制中の未承認ワークフローへの注意。cron ブロックと永続化制限を伝える。 */}
      {governanceBlocked && (
        <p className="border-b border-warning/30 bg-warning-soft/40 px-4 py-1.5 text-xs text-warning">
          {t('governanceBlockedNotice')}
        </p>
      )}

      {/* 保存時のステップバリデーションエラー。該当カードも赤枠でハイライトされる。 */}
      {stepError && (
        <p className="border-b border-error/30 bg-error/5 px-4 py-1.5 text-xs text-error">
          {stepError.message}
        </p>
      )}

      {/* キャンバス: ステージを左から右へ並べる。縦の伸びを避け、横スクロールに逃がす。 */}
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div className="flex items-start gap-1">
          {draft.stages.map((stage, stageIndex) => (
            <div key={stageIndex} className="flex items-start gap-1">
              {/* ステージ間の実行方向を示す矢印。 */}
              {stageIndex > 0 && (
                <ChevronRight
                  size={18}
                  strokeWidth={2}
                  className="mt-16 shrink-0 text-ink-subtle"
                />
              )}
              <section className="w-64 shrink-0 rounded-lg border border-border-subtle bg-surface-sunken/40 p-2">
                <header className="flex items-center justify-between px-1 pb-2">
                  <h3 className="font-mono text-2xs font-semibold tracking-wide text-ink-muted uppercase">
                    {t('stageHeading', { n: stageIndex + 1 })}
                  </h3>
                  <span className="font-mono text-2xs text-ink-subtle">
                    {stage.steps.length > 1 ? t('parallelCount', { n: stage.steps.length }) : ''}
                  </span>
                </header>
                <div className="flex flex-col gap-2">
                  {stage.steps.map((step, stepIndex) => (
                    <StepCard
                      key={step.id}
                      step={step}
                      stepRun={stepRunById.get(step.id)}
                      invalid={stepError?.stepId === step.id}
                      onEdit={() => setStepEditor({ stageIndex, stepIndex, step })}
                      onShowResult={() => {
                        const stepRun = stepRunById.get(step.id);
                        if (stepRun) setResultFor({ stepRunId: stepRun.id, name: step.name });
                      }}
                      t={t}
                    />
                  ))}
                  {/* ステップ追加。空ステージにはステージ削除も出す。 */}
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={Plus}
                    onClick={() =>
                      setStepEditor({ stageIndex, stepIndex: null, step: blankStep() })
                    }
                    className="justify-center border border-dashed border-border-base"
                  >
                    {t('addStepTitle')}
                  </Button>
                  {stage.steps.length === 0 && draft.stages.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeEmptyStage(stageIndex)}
                      className="font-mono text-2xs text-ink-subtle hover:text-error"
                    >
                      {t('removeEmptyStage')}
                    </button>
                  )}
                </div>
              </section>
            </div>
          ))}

          {/* 末尾の「ステージ追加」スタブ列。 */}
          <div className="flex items-start">
            <ChevronRight size={18} strokeWidth={2} className="mt-16 shrink-0 text-ink-subtle" />
            <button
              type="button"
              onClick={() =>
                setDraft((cur) => ({ ...cur, stages: [...cur.stages, { steps: [] }] }))
              }
              className="flex w-40 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-dashed border-border-base px-3 py-6 font-mono text-2xs text-ink-subtle transition-colors hover:border-accent hover:text-accent"
            >
              <Plus size={13} strokeWidth={2} /> {t('addStageButton')}
            </button>
          </div>
        </div>

        {/* 初回 (ステップゼロ) 向けのガイド。 */}
        {totalSteps(draft) === 0 && (
          <p className="mt-6 max-w-md text-sm text-ink-muted">{t('emptyCanvasGuide')}</p>
        )}
      </div>

      {/* 各モーダル。 */}
      <StepEditorModal
        open={stepEditor !== null}
        step={stepEditor?.step ?? null}
        isNew={stepEditor?.stepIndex === null}
        datasources={datasources}
        defaultDatasourceLabel={defaultDatasourceLabel}
        onApply={(step) => stepEditor && applyStep(stepEditor, step)}
        onDelete={
          stepEditor?.stepIndex !== null ? () => stepEditor && removeStep(stepEditor) : undefined
        }
        onClose={() => setStepEditor(null)}
      />
      <WorkflowSettingsModal
        open={settingsOpen}
        draft={draft}
        datasources={datasources}
        onApply={(settings: WorkflowSettings) => {
          patchDraft(settings);
          setSettingsOpen(false);
        }}
        onClose={() => setSettingsOpen(false)}
      />
      <WorkflowRunsModal
        open={runsOpen}
        workflowId={workflowId}
        selectedRunId={selectedRunId}
        onSelect={setSelectedRunId}
        onClose={() => setRunsOpen(false)}
      />
      <StepResultModal
        open={resultFor !== null}
        runId={selectedRunId}
        stepRunId={resultFor?.stepRunId ?? null}
        stepName={resultFor?.name ?? ''}
        onClose={() => setResultFor(null)}
      />

      {/* 削除確認モーダル。 */}
      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={t('deleteWorkflowConfirmTitle')}
        description={
          workflow ? t('deleteWorkflowConfirmDescription', { name: workflow.name }) : undefined
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              {t('cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmDelete(false);
                if (isNew) return;
                remove.mutate(workflowId, {
                  onSuccess: () => {
                    toast.info(t('deleted'), t('workflowRemovedDescription'));
                    continueDocumentNavigation(navigationOwner, closeWorkflow);
                  },
                  onError: () => toast.error(t('deleteFailed'), t('couldNotReachServer')),
                });
              }}
            >
              {t('delete')}
            </Button>
          </>
        }
      />
    </div>
  );
}
