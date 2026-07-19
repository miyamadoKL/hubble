/**
 * アプリ全体で共通利用する汎用文言の辞書。
 * ボタンラベル、相対時刻表示、検索結果なし、削除確認、失敗トーストなど、
 * 複数領域（Schedule / Alert / Notebook / Dashboard / Workflow / GitHub 連携等）で
 * ほぼ同じ言い回しになる文字列だけをここに集約する。
 * 領域固有の文言（フィールドラベル、プレースホルダー等）は各領域の辞書
 * （`schedule.ts` / `alert.ts` / `scheduleBuilder.ts` / `notebook.ts` 等）に置く。
 */
import { defineDictionary } from '../t';

export const commonMessages = defineDictionary({
  cancel: { ja: 'キャンセル', en: 'Cancel' },
  edit: { ja: '編集', en: 'Edit' },
  loading: { ja: '読み込み中…', en: 'Loading…' },
  noMatches: { ja: '一致する項目がありません', en: 'No matches' },
  tryDifferentSearchTerm: {
    ja: '検索語を変えてお試しください。',
    en: 'Try a different search term.',
  },
  couldNotReachServer: {
    ja: 'サーバーに接続できませんでした。',
    en: 'Could not reach the server.',
  },
  serverDidntRespond: {
    ja: 'サーバーから応答がありませんでした。',
    en: "The server didn't respond.",
  },

  // 「次回実行/評価予定」の相対時刻表示。schedule/alert 両パネルの行で共有する。
  dueNow: { ja: 'まもなく実行', en: 'due now' },
  relativeLessThanOneMinute: { ja: '1 分未満', en: 'in <1m' },
  relativeMinutes: { ja: '{n} 分後', en: 'in {n}m' },
  relativeHours: { ja: '{n} 時間後', en: 'in {n}h' },
  relativeDays: { ja: '{n} 日後', en: 'in {n}d' },
  unknown: { ja: '—', en: '—' },

  // 過去方向の相対時刻表示（utils/format.ts の formatRelativeTime）。実行履歴一覧など
  // 「n 分前」のような表示に使う。上の relativeXxx（未来方向、「n 分後」）とは向きが
  // 逆なので別エントリにしている。
  agoJustNow: { ja: 'たった今', en: 'just now' },
  agoMinutes: { ja: '{n} 分前', en: '{n}m ago' },
  agoHours: { ja: '{n} 時間前', en: '{n}h ago' },
  agoDays: { ja: '{n} 日前', en: '{n}d ago' },

  // 削除確認モーダルと削除トーストの共通形。タイトルは対象種別ごとに異なる文言
  // （「スケジュールを削除しますか?」等）になるため各領域の辞書側で個別に持つ。
  deleteConfirmDescription: {
    ja: '「{name}」は完全に削除されます。',
    en: '“{name}” will be permanently removed.',
  },
  delete: { ja: '削除', en: 'Delete' },
  deleted: { ja: '削除しました', en: 'Deleted' },
  deleteFailed: { ja: '削除に失敗しました', en: 'Delete failed' },
  updateFailed: { ja: '更新に失敗しました', en: 'Update failed' },

  // 言語切替トグル（TopBar）。
  switchToJapanese: { ja: '日本語に切り替え', en: 'Switch to Japanese' },
  switchToEnglish: { ja: '英語に切り替え', en: 'Switch to English' },

  // ---- 以下、複数領域で重複していた文言を統合したエントリ群 ----

  // AI アシスタント機能の名称。AiPanel の見出し/トーストタイトルと TopBar の
  // 開閉ボタンラベルで同一の機能名を指すため統合する。
  aiAssistantLabel: { ja: 'AI アシスタント', en: 'AI assistant' },

  // 実行/停止ボタン。AI パネル、TopBar、セルツールバーで共通。
  stopButton: { ja: '停止', en: 'Stop' },
  runButton: { ja: '実行', en: 'Run' },
  runAllCellsTooltip: { ja: '全セルを実行', en: 'Run all cells' },
  runningEllipsis: { ja: '実行中…', en: 'Running…' },

  // 「次回実行/評価予定」のプレフィックス。alert/schedule/workflow のパネル行で共有する。
  nextPrefix: { ja: '次回 {label}', en: 'next {label}' },

  // 作成/保存完了トーストの本文。「「{name}」の準備ができました。」「「{name}」を保存しました。」の形。
  entityReadyBody: { ja: '「{name}」の準備ができました。', en: '“{name}” is ready.' },
  entitySavedBody: { ja: '「{name}」を保存しました。', en: '“{name}” saved.' },

  // 保存ボタン。
  saveButton: { ja: '保存', en: 'Save' },
  savingButton: { ja: '保存中…', en: 'Saving…' },
  saveFailedToastTitle: { ja: '保存に失敗しました', en: 'Save failed' },

  // フォームの汎用フィールドラベル。
  nameLabel: { ja: '名前', en: 'Name' },
  typeLabel: { ja: '種別', en: 'Type' },
  roleLabel: { ja: 'ロール', en: 'Role' },
  // 「グループ」は notebook.ts の chartGroupLabel（散布図のグループ化列）と
  // share.ts の subjectTypeGroup（共有主体の種別）で表記は同一だが翻訳文脈が
  // 異なるため、ここには置かず各領域の辞書に個別に持つ（レビュー指摘）。
  connectionLabel: { ja: '接続先', en: 'Connection' },
  serverDefaultLabel: { ja: 'サーバーの既定', en: 'Server default' },
  sqlPreviewLabel: { ja: 'SQL プレビュー', en: 'SQL preview' },
  savedQueryLabel: { ja: '保存済みクエリ', en: 'Saved query' },
  scheduleLabel: { ja: 'スケジュール', en: 'Schedule' },
  emailLabel: { ja: 'メール', en: 'Email' },

  retryButton: { ja: '再試行', en: 'Retry' },
  closeButton: { ja: '閉じる', en: 'Close' },
  shareButton: { ja: '共有', en: 'Share' },

  loadingChart: { ja: 'チャートを読み込み中…', en: 'Loading chart…' },
  noRows: { ja: '行がありません。', en: 'No rows.' },

  // GitHub 連携ボタン（未連携時の導線）。GithubSyncModal と UserChip の両方で使う。
  connectGithubButton: { ja: 'GitHub と連携', en: 'Connect GitHub' },

  // ノートブック検索プレースホルダー。Sidebar と CommandPalette で共有する。
  searchNotebooksPlaceholder: { ja: 'ノートブックを検索…', en: 'Search notebooks…' },
  newNotebook: { ja: '新規ノートブック', en: 'New notebook' },
  saveNotebookTitle: { ja: 'ノートブックを保存', en: 'Save notebook' },
  untitledNotebook: { ja: '無題のノートブック', en: 'Untitled notebook' },
  noNotebookOpenTitle: { ja: '開いているノートブックがありません', en: 'No notebook open' },
  noNotebooks: { ja: 'ノートブックがありません', en: 'No notebooks' },
  newSqlCellToastTitle: { ja: '新規 SQL セル', en: 'New SQL cell' },

  keyboardShortcutsTitle: { ja: 'キーボードショートカット', en: 'Keyboard shortcuts' },
  formatSqlActionLabel: { ja: 'SQL を整形', en: 'Format SQL' },
  commandPaletteLabel: { ja: 'コマンドパレット', en: 'Command palette' },

  // 経過時間 / 行数の統計ラベル。StatsStrip / HistoryPanel / ScheduleRunsModal で共有する。
  elapsedLabel: { ja: '経過時間', en: 'elapsed' },
  rowsLabel: { ja: '行数', en: 'rows' },
  rowsCountUnit: { ja: '{n} 行', en: '{n} rows' },
  queryFragmentLabel: { ja: 'クエリ', en: 'query' },

  rerunButton: { ja: '再実行', en: 'Re-run' },

  // エクスポート（Google スプレッドシート）関連。notebook/workflow で共有する。
  googleSheetsOption: { ja: 'Google スプレッドシート', en: 'Google Sheets' },
  exportedToSheetsToast: {
    ja: 'Google スプレッドシートにエクスポートしました',
    en: 'Exported to Google Sheets',
  },
  exportFailedToast: { ja: 'エクスポートに失敗しました', en: 'Export failed' },

  // スケジュール/ワークフローの有効・無効表示とトースト。
  disabledLabel: { ja: '無効', en: 'Disabled' },
  neverRunLabel: { ja: '未実行', en: 'never run' },
  disableScheduleAria: { ja: 'スケジュールを無効化', en: 'Disable schedule' },
  enableScheduleAria: { ja: 'スケジュールを有効化', en: 'Enable schedule' },
  runsLabel: { ja: '実行履歴', en: 'Runs' },
  runStartedToast: { ja: '実行を開始しました', en: 'Run started' },
  runFailedTitle: { ja: '実行に失敗しました', en: 'Run failed' },
  couldNotStartRun: { ja: '実行を開始できませんでした。', en: 'Could not start the run.' },
  couldntLoadRuns: { ja: '実行履歴を読み込めませんでした', en: "Couldn't load runs" },
  noRunsYetTitle: { ja: 'まだ実行履歴がありません', en: 'No runs yet' },
} as const);
