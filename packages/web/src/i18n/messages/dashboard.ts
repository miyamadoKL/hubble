/**
 * ダッシュボード機能 (AddWidgetModal / DashboardView / DashboardsPanel /
 * QueryWidgetBody / WidgetCard) で使う文言の辞書。
 * ボタンラベル、見出し、プレースホルダー、空状態、削除確認、トースト、
 * widget 本体のエラー表示など、ダッシュボード領域固有の文言をここに集約する。
 * schedule/alert パネル間で共有される汎用文言 (Cancel/Delete/Loading… など) は
 * `common.ts` 側にあるため、そちらを再利用しここには置かない。
 */
import { defineDictionary } from '../t';

export const dashboardMessages = defineDictionary({
  // --- AddWidgetModal / DashboardView 共通: モーダルタイトルとヘッダーボタン ---
  addWidgetTitle: { ja: 'ウィジェットを追加', en: 'Add widget' },
  addButtonLabel: { ja: '追加', en: 'Add' },

  // --- AddWidgetModal ---
  typeLabel: { ja: '種別', en: 'Type' },
  queryKindLabel: { ja: 'クエリ', en: 'Query' },
  textKindLabel: { ja: 'テキスト', en: 'Text' },
  savedQueryLabel: { ja: '保存済みクエリ', en: 'Saved query' },
  selectSavedQueryPlaceholder: {
    ja: '保存済みクエリを選択…',
    en: 'Select a saved query…',
  },
  displayAsLabel: { ja: '表示形式', en: 'Display as' },
  vizTableLabel: { ja: 'テーブル', en: 'Table' },
  vizChartLabel: { ja: 'チャート', en: 'Chart' },
  vizCounterLabel: { ja: 'カウンター', en: 'Counter' },
  titleOptionalLabel: { ja: 'タイトル（任意）', en: 'Title (optional)' },
  titlePlaceholder: {
    ja: '未入力の場合は保存済みクエリの名前を使用します',
    en: 'Defaults to the saved query name',
  },
  markdownLabel: { ja: 'Markdown', en: 'Markdown' },
  markdownPlaceholder: {
    ja: '# 見出し&#10;**Markdown** のテキストなど…',
    en: '# Heading&#10;Some **markdown** text…',
  },

  // --- DashboardView: ヘッダー ---
  loadingDashboard: { ja: 'ダッシュボードを読み込み中…', en: 'Loading dashboard…' },
  couldntLoadDashboardTitle: {
    ja: 'ダッシュボードを読み込めませんでした',
    en: "Couldn't load dashboard",
  },
  couldntLoadDashboardDescription: {
    ja: '削除されたか、サーバーから応答がありませんでした。',
    en: "It may have been deleted, or the server didn't respond.",
  },
  backButton: { ja: '戻る', en: 'Back' },
  dashboardNameAria: { ja: 'ダッシュボード名', en: 'Dashboard name' },
  untitledDashboard: { ja: '無題のダッシュボード', en: 'Untitled dashboard' },
  savingButton: { ja: '保存中…', en: 'Saving…' },
  saveButton: { ja: '保存', en: 'Save' },
  shareButton: { ja: '共有', en: 'Share' },
  deleteDashboardAria: { ja: 'ダッシュボードを削除', en: 'Delete dashboard' },

  // --- DashboardView: グリッド本体の空状態 ---
  emptyDashboardTitle: { ja: 'ウィジェットがありません', en: 'Empty dashboard' },
  emptyDashboardEditingDescription: {
    ja: 'ウィジェットを追加して始めましょう。',
    en: 'Add a widget to get started.',
  },
  emptyDashboardViewingDescription: {
    ja: 'このダッシュボードにはまだウィジェットがありません。編集ボタンから追加してください。',
    en: 'This dashboard has no widgets yet. Click Edit to add some.',
  },
  unsavedChanges: { ja: '未保存の変更があります', en: 'Unsaved changes' },

  // --- DashboardView: 削除確認モーダル ---
  deleteDashboardConfirmTitle: { ja: 'ダッシュボードを削除しますか?', en: 'Delete dashboard?' },
  deleteDashboardConfirmDescription: {
    ja: '「{name}」は完全に削除されます。参照している保存済みクエリ自体は影響を受けません。',
    en: '“{name}” will be permanently removed. Saved queries it references are not affected.',
  },

  // --- DashboardView: トースト ---
  dashboardCreatedToast: { ja: 'ダッシュボードを作成しました', en: 'Dashboard created' },
  dashboardSavedToast: { ja: 'ダッシュボードを保存しました', en: 'Dashboard saved' },
  saveDashboardFailedToast: {
    ja: 'ダッシュボードの保存に失敗しました',
    en: 'Failed to save dashboard',
  },
  dashboardDeletedToast: { ja: 'ダッシュボードを削除しました', en: 'Dashboard deleted' },
  deleteDashboardFailedToast: {
    ja: 'ダッシュボードの削除に失敗しました',
    en: 'Failed to delete dashboard',
  },

  // --- DashboardsPanel ---
  couldntLoadDashboardsTitle: {
    ja: 'ダッシュボード一覧を読み込めませんでした',
    en: "Couldn't load dashboards",
  },
  newDashboardButton: { ja: '新規ダッシュボード', en: 'New dashboard' },
  noDashboardsTitle: { ja: 'ダッシュボードがありません', en: 'No dashboards' },
  noDashboardsDescription: {
    ja: '保存済みクエリの結果やチャートをグリッドに配置できます。',
    en: 'Arrange saved query results and charts on a grid.',
  },
  // widget 件数表示。ja は単複を区別しないため両エントリとも同じ文言になる。
  widgetCountOne: { ja: '{n} 件のウィジェット', en: '{n} widget' },
  widgetCountOther: { ja: '{n} 件のウィジェット', en: '{n} widgets' },

  // --- QueryWidgetBody ---
  runningStatus: { ja: '実行中…', en: 'Running…' },
  noRows: { ja: '結果行がありません', en: 'No rows' },
  columnIndexNotFound: {
    ja: '結果に列番号 {idx} が見つかりません',
    en: 'Column index {idx} not found in the result',
  },
  nothingToPlot: {
    ja: '描画できるデータがありません: 結果に数値列がありません',
    en: 'Nothing to plot: the result has no numeric column',
  },
  loadingChart: { ja: 'チャートを読み込み中…', en: 'Loading chart…' },
  showingFirstRows: {
    ja: '全 {total} 行中、先頭 {max} 行を表示中',
    en: 'Showing first {max} of {total} rows',
  },
  // widgetQueryCoordinator から投げられる代表的なエラーメッセージの表示用訳文。
  // coordinator 側 (business logic) は英語の生メッセージを投げたままとし、
  // 表示層 (QueryWidgetBody) でこの既知パターンにだけ一致すれば翻訳して表示する。
  queryTimedOutError: { ja: 'クエリがタイムアウトしました', en: 'Query timed out' },
  queryFailedError: { ja: 'クエリが失敗しました', en: 'Query failed' },
  queryCanceledError: { ja: 'クエリがキャンセルされました', en: 'Query canceled' },

  // --- WidgetCard ---
  refreshTooltip: { ja: '再読み込み', en: 'Refresh' },
  refreshWidgetAria: { ja: 'ウィジェットを再読み込み', en: 'Refresh widget' },
  removeWidgetLabel: { ja: 'ウィジェットを削除', en: 'Remove widget' },
  textWidgetTitle: { ja: 'テキスト', en: 'Text' },
} as const);
