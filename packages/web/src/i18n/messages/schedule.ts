/**
 * Schedule 領域（`SchedulesPanel.tsx` / `ScheduleFormModal.tsx`）専用の文言辞書。
 * 両パネルで共有する汎用文言（Cancel、相対時刻表示等）は `messages/common.ts` に、
 * スケジュールビルダー部分は `messages/scheduleBuilder.ts` にある。
 */
import { defineDictionary } from '../t';

export const scheduleMessages = defineDictionary({
  // ---- SchedulesPanel ----
  disabled: { ja: '無効', en: 'Disabled' },
  neverRun: { ja: '未実行', en: 'never run' },
  nextRunPrefix: { ja: '次回 {label}', en: 'next {label}' },
  viewRunHistory: { ja: '実行履歴を表示', en: 'View run history' },
  disableSchedule: { ja: 'スケジュールを無効化', en: 'Disable schedule' },
  enableSchedule: { ja: 'スケジュールを有効化', en: 'Enable schedule' },
  runNow: { ja: '今すぐ実行', en: 'Run now' },
  running: { ja: '実行中…', en: 'Running…' },
  runs: { ja: '実行履歴', en: 'Runs' },
  deleteScheduleAria: { ja: 'スケジュールを削除', en: 'Delete schedule' },
  deleteScheduleTitle: { ja: 'スケジュールを削除しますか?', en: 'Delete schedule?' },
  newSchedule: { ja: '新規スケジュール', en: 'New schedule' },
  noSchedules: { ja: 'スケジュールがありません', en: 'No schedules' },
  createScheduleHint: {
    ja: 'cron の実行間隔でクエリを実行するスケジュールを作成しましょう。',
    en: 'Create a schedule to run a query on a cron cadence.',
  },
  saveQueryFirstHint: {
    ja: 'まずクエリを保存してから、スケジュールを作成してください。',
    en: 'Save a query first, then create a schedule.',
  },
  couldntLoadSchedules: { ja: 'スケジュールを読み込めませんでした', en: "Couldn't load schedules" },

  // トースト。
  runStartedTitle: { ja: '実行を開始しました', en: 'Run started' },
  runStartedBody: { ja: '「{name}」を実行しています。', en: '“{name}” is running.' },
  alreadyRunningTitle: { ja: '実行中です', en: 'Already running' },
  alreadyRunningBody: {
    ja: 'このスケジュールは既に実行中です。',
    en: 'This schedule has a run in progress.',
  },
  runFailedTitle: { ja: '実行に失敗しました', en: 'Run failed' },
  runFailedBody: { ja: '実行を開始できませんでした。', en: 'Could not start the run.' },
  scheduleCreatedTitle: { ja: 'スケジュールを作成しました', en: 'Schedule created' },
  scheduleCreatedBody: { ja: '「{name}」の準備ができました。', en: '“{name}” is ready.' },
  scheduleUpdatedTitle: { ja: 'スケジュールを更新しました', en: 'Schedule updated' },
  scheduleUpdatedBody: { ja: '「{name}」を保存しました。', en: '“{name}” saved.' },
  scheduleRemoved: { ja: 'スケジュールを削除しました。', en: 'Schedule removed.' },

  // ---- ScheduleFormModal ----
  editSchedule: { ja: 'スケジュールを編集', en: 'Edit schedule' },
  newScheduleTitle: { ja: '新規スケジュール', en: 'New schedule' },
  formDescription: {
    ja: '保存済みクエリを cron スケジュールで実行します。SQL 文と実行先は選択したクエリのものが使われます。',
    en: 'Run a saved query on a cron schedule. The statement and datasource come from the query you pick.',
  },
  saveChanges: { ja: '変更を保存', en: 'Save changes' },
  createSchedule: { ja: 'スケジュールを作成', en: 'Create schedule' },
  nameLabel: { ja: '名前', en: 'Name' },
  namePlaceholder: { ja: '例: 夜間の国別集計', en: 'Nightly nation count' },
  queryLabel: { ja: 'クエリ', en: 'Query' },
  savedQueryOption: { ja: '保存済みクエリ', en: 'Saved query' },
  noSavedQueriesYet: {
    ja: '保存済みクエリがまだありません。ノートブックから SQL を保存してください。',
    en: 'No saved queries yet — save one from the notebook first.',
  },
  // 行/列情報の断片。呼び出し側（JSX）で "(...)" や前後の空白を組み立てる。
  locatedWithColumn: { ja: '{line} 行目、{column} 列目', en: 'line {line}, col {column}' },
  locatedLineOnly: { ja: '{line} 行目', en: 'line {line}' },
  connectionLabel: { ja: '接続先', en: 'Connection' },
  serverDefaultLabel: { ja: 'サーバーの既定', en: 'Server default' },
  sqlPreviewLabel: { ja: 'SQL プレビュー', en: 'SQL preview' },
  scheduleLabel: { ja: 'スケジュール', en: 'Schedule' },
  retryPolicyLegend: { ja: 'リトライポリシー', en: 'Retry policy' },
  maxAttemptsLabel: { ja: '最大試行回数', en: 'Max attempts' },
  backoffSecondsLabel: { ja: 'バックオフ（秒）', en: 'Backoff (s)' },
  multiplierLabel: { ja: '倍率', en: 'Multiplier' },
  failureNotificationsLegend: { ja: '失敗時の通知', en: 'Failure notifications' },
  notifyAfterFinalFailure: { ja: '最終失敗後に通知する', en: 'Notify after final failure' },
  slackLabel: { ja: 'Slack', en: 'Slack' },
  emailLabel: { ja: 'メール', en: 'Email' },
  emailRecipientsLabel: { ja: 'メール送信先', en: 'Email recipients' },
  emailRecipientsPlaceholder: {
    ja: 'ops@example.com, data@example.com',
    en: 'ops@example.com, data@example.com',
  },
  addAtLeastOneRecipient: {
    ja: 'メール送信先を 1 件以上指定してください。',
    en: 'Add at least one email recipient.',
  },
  enabledLabel: { ja: '有効', en: 'Enabled' },
  disabledScheduleHint: {
    ja: '（無効なスケジュールは自動実行されません）',
    en: '(disabled schedules never fire automatically)',
  },
} as const);
