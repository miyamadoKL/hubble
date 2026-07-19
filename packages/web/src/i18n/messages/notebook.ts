/**
 * Notebook 領域（`components/notebook/` 配下の全コンポーネントと `editor/` の
 * ユーザー向け文字列）専用の文言辞書。
 * 他パネルと共有する汎用文言（Cancel、削除確認の共通形など）は `messages/common.ts`
 * から import して使う。ここには notebook 固有の文言のみを置く。
 */
import { defineDictionary, t } from '../t';
import type { QueryState } from '@hubble/contracts';
import type { Locale } from '../locale';

export const notebookMessages = defineDictionary({
  // ---- CellToolbar / CellName / LimitControl ----
  collapseCell: { ja: 'セルを折りたたむ', en: 'Collapse cell' },
  expandCell: { ja: 'セルを展開', en: 'Expand cell' },
  cellNameAria: { ja: 'セル名', en: 'Cell name' },
  cellNamePlaceholder: { ja: 'セル名', en: 'Cell name' },
  doubleClickToRename: { ja: 'ダブルクリックで名前を変更', en: 'Double-click to rename' },
  untitledCell: { ja: '無題のセル', en: 'Untitled cell' },
  runCellTooltip: { ja: 'セルを実行', en: 'Run cell' },
  blockedByQueryGuard: { ja: 'Query Guard でブロック中', en: 'Blocked by Query Guard' },
  runBlockedByQueryGuard: { ja: 'Query Guard によりブロック中', en: 'Run blocked by Query Guard' },
  saveQueryButton: { ja: 'クエリを保存', en: 'Save query' },
  deleteCellAria: { ja: 'セルを削除', en: 'Delete cell' },
  dragToReorder: { ja: 'ドラッグして並べ替え', en: 'Drag to reorder' },
  toggleAutoLimit: { ja: 'LIMIT 自動付与を切り替え', en: 'Toggle auto LIMIT' },
  editLimitValue: { ja: 'LIMIT 値を編集', en: 'Edit LIMIT value' },
  limitValueAria: { ja: 'LIMIT 値', en: 'LIMIT value' },

  // ---- StatsStrip ----
  statProgress: { ja: '進捗', en: 'progress' },
  statBytes: { ja: 'バイト数', en: 'bytes' },
  statSplits: { ja: 'スプリット', en: 'splits' },
  statPeakMem: { ja: 'ピークメモリ', en: 'peak mem' },
  truncatedBadge: { ja: '打ち切り', en: 'truncated' },
  trinoUiLink: { ja: 'Trino UI', en: 'Trino UI' },

  // ---- EstimateStrip / SqlCell ----
  estimateUnavailableTooltip: {
    ja: 'このデータソースはスキャン見積もりに対応していません',
    en: 'This data source does not support scan estimates',
  },
  estimateUnavailableStrip: {
    ja: 'このデータソースでは見積もりを利用できません',
    en: 'Estimate unavailable for this data source',
  },
  loadingEditor: { ja: 'エディターを読み込み中…', en: 'Loading editor…' },
  sqlCellAriaPrefix: { ja: 'SQL セル {name}', en: 'SQL cell {name}' },
  // presentation.label(execution/estimate.ts が返す固定の英語ステータス文言。
  // サーバー由来ではなく UI 側の定数)の表示用ラベル。estimateUnavailable* の
  // 既存キーとは用途が異なる(あちらはコスト見積もり自体が未対応の場合の
  // ツールチップ/帯、こちらは見積もり帯本体のステータス語)ため別名にしている。
  estimateScanBadgeLabel: { ja: '見積もりスキャン', en: 'estimated scan' },
  estimateUnavailableBadgeLabel: { ja: '見積もり取得不可', en: 'estimate unavailable' },

  // ---- クエリ状態(QueryState)の表示ラベル ----
  // 契約値(queued/running/finished/failed/canceled)自体は変更せず、表示のみ
  // ロケール別に翻訳する。StatsStrip のバッジ、LastRunStrip の前回実行状態、
  // ResultPane の Details タブで共通利用する(queryStateLabel 関数を参照)。
  queryStateQueued: { ja: '待機中', en: 'Queued' },
  queryStateRunning: { ja: '実行中', en: 'Running' },
  queryStateFinished: { ja: '完了', en: 'Finished' },
  queryStateFailed: { ja: '失敗', en: 'Failed' },
  queryStateCanceled: { ja: 'キャンセル済み', en: 'Canceled' },

  // ---- LastRunStrip ----
  lastRunLabel: { ja: '前回実行', en: 'Last run' },

  // ---- ErrorPanel ----
  readOnlyRoleBadge: { ja: '読み取り専用ロール', en: 'Read-only role' },
  readOnlyRoleMessage: {
    ja: '読み取り専用ロールのため、この SQL は実行できません。書き込みが必要な場合は管理者に相談してください。',
    en: 'This SQL cannot run because your role is read-only. Contact an administrator if write access is required.',
  },
  queryBlockedBadge: { ja: 'クエリがブロックされました', en: 'Query blocked' },
  scanEstimateExceedsLimit: {
    ja: 'スキャン見積もりが設定上限を超えています',
    en: 'scan estimate exceeds the configured limit',
  },
  scanRowsLabel: { ja: 'スキャン行数', en: 'scan rows' },
  scanBytesLabel: { ja: 'スキャンバイト数', en: 'scan bytes' },
  unknownValue: { ja: '不明', en: 'unknown' },
  noLimitValue: { ja: '上限なし', en: 'no limit' },
  scanLimitSuffix: { ja: ' / 上限 {limit}', en: ' / limit {limit}' },

  // ---- ResultPane ----
  copyAsTsvHtml: { ja: 'TSV + HTML としてコピー', en: 'Copy as TSV + HTML' },
  copiedLabel: { ja: 'コピーしました', en: 'Copied' },
  noResultTitle: { ja: '結果なし', en: 'No result' },
  noRowsTitle: { ja: '行がありません', en: 'No rows' },
  statementFailedDesc: {
    ja: 'ステートメントが失敗しました。上のエラーを確認してください。',
    en: 'The statement failed — see the error above.',
  },
  noRowsDesc: {
    ja: 'このステートメントは行を返しませんでした。',
    en: 'This statement returned no rows.',
  },
  // 2項の並列だが中黒(・)は使わず読点でつなぐ(scheduleMessages.locatedWithColumn と同じ規約)。
  resultFooter: { ja: '{rows} 行、{columns} 列', en: '{rows} rows · {columns} columns' },
  resultTruncatedWarning: {
    ja: '行数上限に達したため結果が打ち切られました',
    en: 'result truncated at the row cap',
  },
  gridTab: { ja: 'グリッド', en: 'Grid' },
  chartTab: { ja: 'チャート', en: 'Chart' },
  explainTab: { ja: 'Explain', en: 'Explain' },
  detailsTab: { ja: '詳細', en: 'Details' },
  explainRunningMessage: { ja: 'EXPLAIN を実行中…', en: 'Running EXPLAIN…' },
  explainPlanTitle: { ja: '実行計画', en: 'Explain plan' },
  explainPlanDesc: {
    ja: '現在のステートメントに対して EXPLAIN を実行すると、分散実行計画を確認できます。',
    en: 'Run EXPLAIN on the current statement to see its distributed plan.',
  },
  runExplainButton: { ja: 'EXPLAIN を実行', en: 'Run EXPLAIN' },
  emptyPlanText: { ja: '(空のプラン)', en: '(empty plan)' },
  detailQueryId: { ja: 'クエリ ID', en: 'Query id' },
  detailTrinoQueryId: { ja: 'Trino クエリ ID', en: 'Trino query id' },
  detailSubmitted: { ja: '送信日時', en: 'Submitted' },
  detailFinished: { ja: '完了日時', en: 'Finished' },
  detailState: { ja: '状態', en: 'State' },
  detailElapsed: { ja: '経過時間', en: 'Elapsed' },
  detailWallTime: { ja: 'ウォールタイム', en: 'Wall time' },
  detailProcessedRows: { ja: '処理行数', en: 'Processed rows' },
  detailProcessedBytes: { ja: '処理バイト数', en: 'Processed bytes' },
  detailPeakMemory: { ja: 'ピークメモリ', en: 'Peak memory' },
  detailSplits: { ja: 'スプリット', en: 'Splits' },
  detailWorkerNodes: { ja: 'ワーカーノード数', en: 'Worker nodes' },
  exportResultAria: { ja: '結果をエクスポート', en: 'Export result' },
  exportTrigger: { ja: 'エクスポート', en: 'Export' },
  downloadSectionLabel: { ja: 'ダウンロード', en: 'Download' },
  exportToSectionLabel: { ja: 'エクスポート先', en: 'Export to' },
  csvZipOption: { ja: 'CSV (zip)', en: 'CSV (zip)' },
  csvOption: { ja: 'CSV', en: 'CSV' },
  xlsxOption: { ja: 'XLSX', en: 'XLSX' },
  s3CsvOption: { ja: 'S3 (CSV, gzip)', en: 'S3 (CSV, gzip)' },
  s3XlsxOption: { ja: 'S3 (XLSX)', en: 'S3 (XLSX)' },
  partialDownloadNote: {
    ja: 'ダウンロードにはバッファ済みの行のみが含まれます（{code}: 全件ダウンロードでこのステートメントを再実行できません）。',
    en: 'Downloads include buffered rows only ({code}: full download cannot re-run this statement).',
  },
  exportedToS3Toast: { ja: 'S3 にエクスポートしました', en: 'Exported to S3' },

  // ---- ResultGrid ----
  showHideColumns: { ja: '列の表示/非表示', en: 'Show / hide columns' },
  columnStats: { ja: '列の統計', en: 'Column stats' },
  filterRowsAria: { ja: '行をフィルタ', en: 'Filter rows' },
  clearFilterAria: { ja: 'フィルタをクリア', en: 'Clear filter' },
  filterAllRowsServerPlaceholder: {
    ja: '全行をフィルタ（サーバー）…',
    en: 'Filter all rows (server)…',
  },
  filterLoadedRowsPlaceholder: { ja: '読み込み済み行をフィルタ…', en: 'Filter loaded rows…' },
  searchingEllipsis: { ja: '検索中…', en: 'searching…' },
  firstNOfMMatchedServer: {
    ja: '一致 {total} 件中 先頭 {first} 件（サーバー）',
    en: 'first {first} of {total} matched (server)',
  },
  nMatchedServer: { ja: '{total} 件一致（サーバー）', en: '{total} matched (server)' },
  loadedCount: { ja: '{n} 件読み込み済み', en: '{n} loaded' },
  filteredLoadedCount: {
    ja: '{filtered} / {total} 件読み込み済み',
    en: '{filtered} / {total} loaded',
  },
  searchColumnsPlaceholder: { ja: '列を検索…', en: 'Search columns…' },
  searchColumnsAria: { ja: '列を検索', en: 'Search columns' },
  noMatchingColumns: { ja: '一致する列がありません。', en: 'No matching columns.' },
  columnSortTitle: {
    ja: '{name}（{type}）: クリックでソート',
    en: '{name} ({type}) — click to sort',
  },
  resultHeightAria: { ja: '結果表示域の高さを調整', en: 'Resize result area height' },

  // ---- ColumnProfilePanel ----
  profilingResult: { ja: 'プロファイル取得中…', en: 'Profiling result…' },
  rowsProfiledSuffix: { ja: '{n} 行をプロファイル済み', en: '{n} rows profiled' },
  stillRunningSuffix: { ja: '（実行中）', en: ' (still running)' },
  profileNulls: { ja: 'null 数', en: 'nulls' },
  profileDistinct: { ja: '個別値数', en: 'distinct' },
  profileMin: { ja: '最小値', en: 'min' },
  profileMax: { ja: '最大値', en: 'max' },

  // ---- ChartControls / ChartPanel ----
  chartTypeBars: { ja: '棒グラフ', en: 'Bars' },
  chartTypeLines: { ja: '折れ線グラフ', en: 'Lines' },
  chartTypeTimeline: { ja: 'タイムライン', en: 'Timeline' },
  chartTypePie: { ja: '円グラフ', en: 'Pie' },
  chartTypeScatter: { ja: '散布図', en: 'Scatter' },
  xAxisMeasureLabel: { ja: 'X（測定値）', en: 'X (measure)' },
  xAxisLabel: { ja: 'X 軸', en: 'X axis' },
  yAxisValueLabel: { ja: '値', en: 'Value' },
  yAxisLabel: { ja: 'Y 軸', en: 'Y axis' },
  sizeLabel: { ja: 'サイズ', en: 'Size' },
  sortLabel: { ja: '並び替え', en: 'Sort' },
  limitLabel: { ja: '上限', en: 'Limit' },
  noneOption: { ja: 'なし', en: 'None' },
  ascendingOption: { ja: '昇順', en: 'Ascending' },
  descendingOption: { ja: '降順', en: 'Descending' },
  allLoadedOption: { ja: '読み込み済み全件', en: 'All loaded' },
  xAxisColumnAria: { ja: 'X 軸の列', en: 'X axis column' },
  yAxisColumnAria: { ja: 'Y 軸の列', en: 'Y axis column' },
  scatterGroupingColumnAria: { ja: '散布図のグループ化列', en: 'Scatter grouping column' },
  // 散布図のグループ化に使う列を選ぶフィールドのラベル。share.ts の subjectTypeGroup
  // （共有主体としての「グループ」）とは概念が異なるため共通化しない
  // （レビュー指摘: 表記が同一でも翻訳文脈が別）。
  chartGroupLabel: { ja: 'グループ', en: 'Group' },
  scatterSizeColumnAria: { ja: '散布図の点サイズ列', en: 'Scatter point-size column' },
  sortOrderAria: { ja: '並び替え順', en: 'Sort order' },
  rowLimitAria: { ja: '行数の上限', en: 'Row limit' },
  yAxisColumnsAria: { ja: 'Y 軸の列群', en: 'Y axis columns' },
  selectEllipsis: { ja: '選択…', en: 'Select…' },
  nColumnsSummary: { ja: '{n} 列', en: '{n} columns' },
  noNumericColumns: { ja: '数値列がありません。', en: 'No numeric columns.' },
  noRowsToChartTitle: { ja: 'チャートにする行がありません', en: 'No rows to chart' },
  noRowsToChartDesc: {
    ja: '行を返すクエリを実行するとチャートを描画できます。',
    en: 'Run a query that returns rows to plot a chart.',
  },
  nothingToPlotTitle: { ja: '描画できるデータがありません', en: 'Nothing to plot' },
  nothingToPlotDesc: {
    ja: 'チャートには数値列が少なくとも1つ必要です。この結果には数値列がありません。',
    en: 'A chart needs at least one numeric column. This result has none.',
  },

  // ---- VariablePanel ----
  variablesHeading: { ja: '変数', en: 'Variables' },
  notebookVariablesAria: { ja: 'ノートブック変数', en: 'Notebook variables' },
  parameterCountOne: { ja: '{n} 個のパラメータ', en: '{n} parameter' },
  parameterCountOther: { ja: '{n} 個のパラメータ', en: '{n} parameters' },

  // ---- SaveQueryModal ----
  saveQueryModalTitle: { ja: 'クエリを保存', en: 'Save query' },
  saveQueryModalDescription: {
    ja: 'このセルの SQL を保存済みクエリとして保存すると、あとで見つけて再利用できます。',
    en: "Save this cell's SQL as a saved query you can find and reuse later.",
  },
  nameRequiredError: { ja: '名前は必須です。', en: 'Name is required.' },
  savedQueryNamePlaceholder: { ja: '例: 日次アクティブユーザー数', en: 'e.g. Daily active users' },
  descriptionOptionalLabel: { ja: '説明（任意）', en: 'Description (optional)' },
  savedQueryDescriptionPlaceholder: { ja: 'このクエリの用途', en: 'What this query is for' },
  saveQueryCreatedToastTitle: { ja: '保存済みクエリを作成しました', en: 'Saved query created' },
  saveQueryCreatedToastBody: { ja: '「{name}」を保存しました。', en: '“{name}” was saved.' },
  invalidInputFallback: { ja: '入力内容が正しくありません。', en: 'Invalid input.' },

  // ---- SaveNotebookModal ----
  saveNotebookModalDescription: {
    ja: 'サーバーに保存するノートブックの名前を入力してください。',
    en: 'Give the notebook a name to save it to the server.',
  },
  notebookNameLabel: { ja: 'ノートブック名', en: 'Notebook name' },

  // ---- MarkdownCell ----
  editMarkdownAria: { ja: 'Markdown を編集', en: 'Edit markdown' },
  emptyMarkdownPlaceholder: {
    ja: '空の Markdown セル（クリックして編集）',
    en: 'Empty markdown cell — click to edit',
  },
  markdownSourceAria: { ja: 'Markdown ソース', en: 'Markdown source' },
  markdownEditorPlaceholder: {
    ja: 'Markdown を入力…（Ctrl+Enter でレンダリング）',
    en: 'Write markdown… (Ctrl+Enter to render)',
  },

  // ---- PresentationView ----
  presentationLabel: { ja: 'プレゼンテーション', en: 'Presentation' },
  exitButton: { ja: '終了', en: 'Exit' },
  nothingToPresentTitle: { ja: '表示できるスライドがありません', en: 'Nothing to present' },
  nothingToPresentDesc: {
    ja: '`-- 見出し` コメント付きの SQL または Markdown セルを追加するとスライドを作成できます。',
    en: 'Add SQL with `-- heading` comments or Markdown cells to build slides.',
  },

  // ---- NotebookView / NotebookHeader / ViewportCell ----
  noNotebookOpenDesc: {
    ja: 'ノートブックを作成すると SQL セルの作成を始められます。',
    en: 'Create a notebook to start composing SQL cells.',
  },
  missingVariableToastTitle: { ja: '変数の値が未入力です', en: 'Missing variable value' },
  missingVariableToastBody: {
    ja: '実行する前に {vars} の値を入力してください。',
    en: 'Provide a value for {vars} before running.',
  },
  missingVariableToastBodyShort: {
    ja: '{vars} の値を入力してください。',
    en: 'Provide a value for {vars}.',
  },
  deleteCellModalTitle: { ja: 'セルを削除しますか?', en: 'Delete cell?' },
  deleteCellModalDesc: {
    ja: 'この {kind} セルには内容があります。削除すると元に戻せません。',
    en: 'This {kind} cell has content. Deleting it cannot be undone.',
  },
  deleteCellConfirmButton: { ja: 'セルを削除', en: 'Delete cell' },
  blockedByQueryGuardToastTitle: {
    ja: 'Query Guard にブロックされました',
    en: 'Blocked by Query Guard',
  },
  exceedsScanLimitFallback: {
    ja: 'このクエリはスキャン上限を超えています。',
    en: 'This query exceeds the scan limit.',
  },
  clickToRenameTitle: { ja: 'クリックして名前を変更', en: 'Click to rename' },
  clickToEditDescriptionTitle: { ja: 'クリックして説明を編集', en: 'Click to edit description' },
  addDescriptionPlaceholder: { ja: '説明を追加…', en: 'Add a description…' },
  readOnlyBadge: { ja: '読み取り専用', en: 'Read-only' },
  notebookDescriptionAria: { ja: 'ノートブックの説明', en: 'Notebook description' },
  notebookWidthAria: { ja: 'ノートブックの幅を調整', en: 'Resize notebook width' },
  emptyCellFallback: { ja: '空のセル', en: 'Empty cell' },
  cellKindFallback: { ja: '{kind} セル', en: '{kind} cell' },

  // ---- editor/SqlEditor.tsx, editor/registerTrinoLanguage.ts ----
  sqlEditorHeightAria: { ja: 'SQL エディターの高さを調整', en: 'Resize SQL editor height' },
  runSqlActionLabel: { ja: 'SQL を実行', en: 'Run SQL' },
} as const);

// QueryState の各値を辞書のキーへマッピングするテーブル。
const QUERY_STATE_LABEL_KEY = {
  queued: 'queryStateQueued',
  running: 'queryStateRunning',
  finished: 'queryStateFinished',
  failed: 'queryStateFailed',
  canceled: 'queryStateCanceled',
} as const satisfies Record<QueryState, keyof typeof notebookMessages>;

// state が既知の QueryState かどうかを判定する type guard。QUERY_STATE_LABEL_KEY で
// 網羅している 5 値かどうかだけを見る。
function isQueryState(state: string): state is QueryState {
  return Object.hasOwn(QUERY_STATE_LABEL_KEY, state);
}

/**
 * クエリ状態(QueryState)の契約値から、画面表示用の翻訳済みラベルを求める。
 * 契約値自体は変更せず表示だけを翻訳する(StatsStrip のバッジ、LastRunStrip の
 * 前回実行状態、ResultPane の Details タブで共通利用する)。
 *
 * `state` は `string` を受け取る: `CellResultMeta.state`(LastRunStrip が使う)は
 * 「厳密な QueryState との整合は呼び出し側の責務」という緩い string 型で定義されて
 * いるため、既知の QueryState 以外の値が来ても例外を投げず、元の文字列を
 * そのまま返す(fail-safe なフォールバック)。type guard で narrow してから
 * QUERY_STATE_LABEL_KEY を引くことで、`t()` に渡すキーの型を dict 全体ではなく
 * この 5 キーだけに絞り、placeholder 引数不要であることを型検査でも保証する。
 */
export function queryStateLabel(state: string, locale: Locale): string {
  if (!isQueryState(state)) return state;
  return t(notebookMessages, QUERY_STATE_LABEL_KEY[state], locale);
}
