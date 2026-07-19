/**
 * クエリワークフロー機能（`components/workflow/` 配下の全コンポーネント）で使う文言辞書。
 * ワークフロー一覧パネル、編集/実行ビュー、ステップ編集、結果、実行履歴、設定の各モーダル、
 * 一括エクスポートメニュー、実行状態バッジで使う文字列をまとめて持つ。
 *
 * 実行ステータス（`WorkflowRunStatus` / `WorkflowStepRunStatus` の各値、`onFailure` の
 * `stop`/`continue`）は契約層の値であり、ロジック上のリテラルは変更しない。ここに置くのは
 * その表示ラベルだけで、実際の変換（値 → 辞書キー）は `workflowFormat.ts` の
 * マッピングテーブルと、各コンポーネント側の小さなマッピングで行う。
 */
import { defineDictionary } from '../t';

export const workflowMessages = defineDictionary({
  // ---- RunExportMenu ----
  exportFormatCsvZip: { ja: 'CSV（zip）', en: 'CSV (zip)' },
  exportFormatXlsx: { ja: 'Excel（複数シート）', en: 'Excel (multi-sheet)' },
  exportRunResultsAria: { ja: '実行結果をエクスポート', en: 'Export run results' },

  // ---- StepEditorModal ----
  addStepTitle: { ja: 'ステップを追加', en: 'Add step' },
  editStepTitle: { ja: 'ステップを編集', en: 'Edit step' },
  removeStepButton: { ja: 'ステップを削除', en: 'Remove step' },
  applyButton: { ja: '適用', en: 'Apply' },
  sqlStatementFieldLabel: { ja: 'SQL 文', en: 'SQL statement' },
  datasourceFieldLabel: { ja: 'データソース', en: 'Datasource' },
  onFailureFieldLabel: { ja: '失敗した場合', en: 'If this step fails' },
  catalogOptionalFieldLabel: { ja: 'カタログ（任意）', en: 'Catalog (optional)' },
  schemaOptionalFieldLabel: { ja: 'スキーマ（任意）', en: 'Schema (optional)' },
  stepNamePlaceholder: { ja: '例: 日次集計を作成', en: 'e.g. Build daily aggregate' },
  workflowDefaultOption: { ja: 'ワークフローの既定（{label}）', en: 'Workflow default ({label})' },
  onFailureStopOption: { ja: 'ワークフローを停止', en: 'Stop the workflow' },
  onFailureContinueOption: { ja: '次のステージへ進む', en: 'Continue to the next stage' },

  // ---- StepResultModal ----
  resultModalTitle: { ja: '結果: {name}', en: 'Result: {name}' },
  rowsPersisted: { ja: '{n} 行を永続化済み', en: '{n} rows persisted' },
  pageOf: { ja: '{page} / {total} ページ', en: 'page {page} / {total}' },
  prevButton: { ja: '前へ', en: 'Prev' },
  nextButton: { ja: '次へ', en: 'Next' },
  loadingResult: { ja: '結果を読み込み中…', en: 'Loading result…' },
  resultNotAvailableTitle: { ja: '結果を利用できません', en: 'Result not available' },
  couldntLoadResultTitle: { ja: '結果を読み込めませんでした', en: "Couldn't load the result" },
  resultExpiredDescription: {
    ja: '結果は永続化されていないか、期限切れです。',
    en: 'The result was not persisted or has expired.',
  },

  // ---- WorkflowRunsModal ----
  runHistoryTitle: { ja: '実行履歴', en: 'Run history' },
  noRunsYetDescription: {
    ja: 'ワークフローを実行すると、ここに履歴が表示されます。',
    en: 'Run the workflow to see its history here.',
  },
  stepCountsOk: { ja: '{success}/{total} 件成功', en: '{success}/{total} ok' },
  stepCountsFailed: { ja: '{n} 件失敗', en: '{n} failed' },
  stepCountsBlocked: { ja: '{n} 件ブロック', en: '{n} blocked' },
  stepCountsSkipped: { ja: '{n} 件スキップ', en: '{n} skipped' },
  // run 行のステップ内訳を並べる区切り。日本語文中では中黒/中点による並列を
  // 使わないため読点にする（英語側は既存の " · " 区切りの慣習を維持する）。
  runBreakdownSeparator: { ja: '、', en: ' · ' },
  // トリガー (manual/cron) の表示ラベル。契約値自体は変更せず、表示のみ翻訳する。
  triggerManual: { ja: '手動', en: 'manual' },
  triggerCron: { ja: 'スケジュール', en: 'schedule' },

  // ---- WorkflowSettingsModal ----
  workflowSettingsTitle: { ja: 'ワークフロー設定', en: 'Workflow settings' },
  descriptionFieldLabel: { ja: '説明', en: 'Description' },
  defaultDatasourceFieldLabel: { ja: '既定のデータソース', en: 'Default datasource' },
  scheduleCronFieldLabel: { ja: 'スケジュール（任意）', en: 'Schedule (optional)' },
  descriptionPlaceholder: {
    ja: 'このワークフローは何を生成しますか?',
    en: 'What does this workflow produce?',
  },
  cronPlaceholder: {
    ja: '例: 0 7 * * 1-5（空欄で手動のみ）',
    en: 'e.g. 0 7 * * 1-5 (leave empty for manual only)',
  },
  cronValidationError: {
    ja: '分 時 日 月 曜日 の 5 項目で入力してください。',
    en: 'Enter 5 fields: minute hour day month weekday.',
  },
  scheduleEnabledLabel: { ja: 'スケジュール有効', en: 'Schedule enabled' },

  // ---- WorkflowStatusBadge / workflowFormat.runStatusLabel ----
  // 契約値（running/success/partial/failed/blocked/aborted）自体は変更せず、表示だけ翻訳する。
  runStatusRunning: { ja: '実行中', en: 'running' },
  runStatusSuccess: { ja: '成功', en: 'success' },
  runStatusPartial: { ja: '一部成功', en: 'partial' },
  runStatusFailed: { ja: '失敗', en: 'failed' },
  runStatusBlocked: { ja: 'ブロック', en: 'blocked' },
  runStatusAborted: { ja: '中断', en: 'aborted' },

  // ---- workflowFormat.nextRunLabel ----
  manualOnly: { ja: '手動のみ', en: 'manual only' },

  // ---- WorkflowsPanel ----
  stepCountSingular: { ja: '1 ステップ', en: '1 step' },
  stepCountPlural: { ja: '{n} ステップ', en: '{n} steps' },
  newWorkflowButton: { ja: '新規ワークフロー', en: 'New workflow' },
  noWorkflowsTitle: { ja: 'ワークフローがありません', en: 'No workflows' },
  noWorkflowsDescription: {
    ja: 'クエリをステージにまとめて連続実行できます。',
    en: 'Chain queries into stages and run them together.',
  },
  couldntLoadWorkflowsTitle: {
    ja: 'ワークフローを読み込めませんでした',
    en: "Couldn't load workflows",
  },

  // ---- WorkflowView ----
  backToNotebooks: { ja: 'ノートブックへ戻る', en: 'Back to notebooks' },
  loadingWorkflow: { ja: 'ワークフローを読み込み中…', en: 'Loading workflow…' },
  couldntLoadWorkflowTitle: {
    ja: 'ワークフローを読み込めませんでした',
    en: "Couldn't load the workflow",
  },
  mayHaveBeenDeleted: { ja: '削除された可能性があります。', en: 'It may have been deleted.' },
  untitledWorkflow: { ja: '無題のワークフロー', en: 'Untitled workflow' },
  workflowNameAria: { ja: 'ワークフロー名', en: 'Workflow name' },

  // ---- draftProblem (保存可否バリデーション) ----
  giveWorkflowNameError: {
    ja: 'ワークフローに名前を付けてください。',
    en: 'Give the workflow a name.',
  },
  addAtLeastOneStepError: {
    ja: 'ステップを少なくとも 1 つ追加してください。',
    en: 'Add at least one step.',
  },
  stepNeedsNameAndStatementError: {
    ja: 'ステップ「{name}」には名前と SQL 文が必要です。',
    en: 'Step "{name}" needs a name and a SQL statement.',
  },
  unsavedChanges: { ja: '未保存の変更', en: 'unsaved changes' },
  deleteWorkflowAria: { ja: 'ワークフローを削除', en: 'Delete workflow' },
  saveBeforeRunningTitle: {
    ja: '実行する前にワークフローを保存してください',
    en: 'Save the workflow before running',
  },
  runAllStagesTitle: { ja: 'すべてのステージを順番に実行', en: 'Run all stages in order' },
  governanceBlockedNotice: {
    ja:
      'ガバナンスが有効です。このワークフローが GitHub 上で承認されるまで、スケジュール実行は' +
      'ブロックされ、結果も永続化されません。プッシュしてプルリクエストをマージしてください。',
    en:
      'Governance is on: scheduled runs are blocked and results are not persisted until ' +
      'this workflow is approved on GitHub. Push it and get the pull request merged.',
  },
  stageHeading: { ja: 'ステージ {n}', en: 'Stage {n}' },
  parallelCount: { ja: '{n} 件並列', en: '{n} parallel' },
  removeEmptyStage: { ja: '空のステージを削除', en: 'Remove empty stage' },
  addStageButton: { ja: 'ステージを追加', en: 'Add stage' },
  emptyCanvasGuide: {
    ja:
      'ステージ 1 にステップを追加してください。同じステージ内のステップは並列実行され、' +
      'ステージは左から右へ順に実行されます。各ステップは失敗時にワークフローを停止するか、' +
      '次へ進めるかを選べます。',
    en:
      'Add steps to Stage 1. Steps in the same stage run in parallel; stages run left to right. ' +
      'Each step can stop the workflow or let it continue when it fails.',
  },
  untitledStep: { ja: '無題のステップ', en: 'untitled step' },
  onFailureStopTitle: { ja: '失敗時: ワークフローを停止', en: 'On failure: stop the workflow' },
  onFailureContinueTitle: { ja: '失敗時: 続行', en: 'On failure: continue' },
  onFailureStopShort: { ja: '停止', en: 'stop' },
  onFailureContinueShort: { ja: '続行', en: 'continue' },
  viewResultTitle: { ja: '永続化済みの結果を表示', en: 'View persisted result' },
  viewResultAria: { ja: '{name} の結果を表示', en: 'View result of {name}' },
  deleteWorkflowConfirmTitle: { ja: 'ワークフローを削除しますか?', en: 'Delete workflow?' },
  deleteWorkflowConfirmDescription: {
    ja: '「{name}」と実行履歴は完全に削除されます。',
    en: '“{name}” and its run history will be permanently removed.',
  },
  workflowCreatedToast: { ja: 'ワークフローを作成しました', en: 'Workflow created' },
  workflowReadyToRun: { ja: '「{name}」は実行できる状態です。', en: '“{name}” is ready to run.' },
  workflowSavedToast: { ja: 'ワークフローを保存しました', en: 'Workflow saved' },
  workflowIsRunning: { ja: '「{name}」を実行中です。', en: '“{name}” is running.' },
  alreadyRunningToast: { ja: 'すでに実行中です', en: 'Already running' },
  alreadyRunningDescription: {
    ja: 'このワークフローはすでに実行中です。',
    en: 'This workflow has a run in progress.',
  },
  workflowRemovedDescription: { ja: 'ワークフローを削除しました。', en: 'Workflow removed.' },
} as const);
