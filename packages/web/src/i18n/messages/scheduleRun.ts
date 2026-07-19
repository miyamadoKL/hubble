/**
 * スケジュール実行結果（`ScheduleRunStatus`）の表示ラベルと、実行履歴モーダル
 * （`ScheduleRunsModal.tsx`）専用の文言辞書。契約層の値（`running` / `success` /
 * `failed` / `aborted` / `blocked`）自体は変更せず、画面表示だけを翻訳する。
 */
import { defineDictionary } from '../t';

export const scheduleRunMessages = defineDictionary({
  // ---- 実行状態ラベル（ScheduleStatusBadge / scheduleFormat.runStatusLabel） ----
  statusRunning: { ja: '実行中', en: 'RUNNING' },
  statusSuccess: { ja: '成功', en: 'SUCCESS' },
  statusFailed: { ja: '失敗', en: 'FAILED' },
  statusAborted: { ja: '中断', en: 'ABORTED' },
  statusBlocked: { ja: 'ブロック', en: 'BLOCKED' },

  // ---- 試行回数表記（scheduleFormat.attemptLabel） ----
  attemptSingular: { ja: '1 回目の試行', en: '1 attempt' },
  attemptPlural: { ja: '{n} 回の試行', en: '{n} attempts' },

  // ---- ScheduleRunsModal ----
  runsTitle: { ja: '実行履歴', en: 'Runs' },
  // ja は em ダッシュを使わず、既存の「"{name}"の...」という文言規約に合わせる。
  runsTitleFor: { ja: '「{name}」の実行履歴', en: 'Runs — {name}' },
  runsDescription: {
    ja: '新しい実行から順に表示しています。リトライが尽きて失敗した実行は試行回数を併記します。',
    en: 'Most recent runs first. A failed run that exhausted its retries shows the attempt count.',
  },
  couldntLoadRuns: { ja: '実行履歴を読み込めませんでした', en: "Couldn't load runs" },
  noRunsYetTitle: { ja: 'まだ実行履歴がありません', en: 'No runs yet' },
  noRunsYetDescription: {
    ja: 'スケジュールが実行される、または手動で実行するとここに表示されます。',
    en: 'Runs appear here once the schedule fires or you trigger it manually.',
  },
  tookNAttempts: { ja: 'この実行は {n} 回試行しました', en: 'This run took {n} attempts' },
  rowsItem: { ja: '行数', en: 'rows' },
  elapsedItem: { ja: '所要時間', en: 'elapsed' },
  attemptItem: { ja: '試行回数', en: 'attempt' },
  queryItem: { ja: 'クエリ', en: 'query' },
  failedAfterAttempts: { ja: '（{label}後に失敗）', en: ' (failed after {label})' },
} as const);
