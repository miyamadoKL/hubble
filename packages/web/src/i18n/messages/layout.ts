/**
 * アプリのシェル（TopBar / Sidebar / ContextSelector / UserChip / NotebookTabs /
 * DatasourceSelector / AppShell / Logo）と、共通コンポーネント（ShortcutsHelp /
 * SearchInput / Modal の共通ボタン）で使う文言の辞書。
 * schedule/alert 領域と違い単一パネルではなくシェル全体にまたがるため、
 * コンポーネント別にコメントで区切って管理する。
 */
import { defineDictionary } from '../t';

export const layoutMessages = defineDictionary({
  // ---- TopBar ----
  closeAiAssistant: { ja: 'AI アシスタントを閉じる', en: 'Close AI assistant' },
  // 開くボタンの aria-label（機能名自体）は common.aiAssistantLabel を使う。
  // 元の英語文言（"Command palette  (Ctrl K)"）は 2 個の連続スペースを含む既存表記。
  // en は既存文言維持のためそのまま残す。
  commandPalette: { ja: 'コマンドパレット（Ctrl K）', en: 'Command palette  (Ctrl K)' },
  lightTheme: { ja: 'ライトテーマ', en: 'Light theme' },
  darkTheme: { ja: 'ダークテーマ', en: 'Dark theme' },
  themePreferenceSavedBody: { ja: 'テーマ設定を保存しました。', en: 'Theme preference saved.' },
  closeNotebookTitle: { ja: 'ノートブックを閉じますか?', en: 'Close notebook?' },
  closeNotebookDescription: {
    ja: '「{name}」には未保存の変更があります。閉じると破棄されます。',
    en: '“{name}” has unsaved changes. Closing it will discard them.',
  },
  discardAndClose: { ja: '破棄して閉じる', en: 'Discard & close' },

  // ---- Sidebar: アイコンレール（タブ切替）とパネル見出し ----
  railData: { ja: 'データ', en: 'Data' },
  railNotebooks: { ja: 'ノートブック', en: 'Notebooks' },
  railSaved: { ja: '保存済み', en: 'Saved' },
  railHistory: { ja: '履歴', en: 'History' },
  railSchedules: { ja: 'スケジュール', en: 'Schedules' },
  railAlerts: { ja: 'アラート', en: 'Alerts' },
  railDashboards: { ja: 'ダッシュボード', en: 'Dashboards' },
  railWorkflows: { ja: 'ワークフロー', en: 'Workflows' },
  railOperations: { ja: 'オペレーション', en: 'Operations' },
  // panelTitleData / panelTitleSaved は同じタブでもレール表示とパネル見出しの文言が
  // 異なる（例: レールは「データ」、見出しは「データブラウザ」）ため個別に持つ。
  // それ以外のタブはレールとパネル見出しが同一文言なので railXxx を再利用する。
  panelTitleData: { ja: 'データブラウザ', en: 'Data browser' },
  panelTitleSaved: { ja: '保存済みクエリ', en: 'Saved queries' },
  filterTables: { ja: 'テーブルを絞り込み…', en: 'Filter tables…' },
  searchSavedQueries: { ja: '保存済みクエリを検索…', en: 'Search saved queries…' },
  searchHistory: { ja: '履歴を検索…', en: 'Search history…' },
  searchSchedules: { ja: 'スケジュールを検索…', en: 'Search schedules…' },
  searchAlerts: { ja: 'アラートを検索…', en: 'Search alerts…' },
  searchDashboards: { ja: 'ダッシュボードを検索…', en: 'Search dashboards…' },
  searchWorkflows: { ja: 'ワークフローを検索…', en: 'Search workflows…' },
  filterQueries: { ja: 'クエリを絞り込み…', en: 'Filter queries…' },
  collapseSidebar: { ja: 'サイドバーを折りたたむ', en: 'Collapse sidebar' },
  resizeSidebar: { ja: 'サイドバーの幅を変更', en: 'Resize sidebar' },

  // ---- ContextSelector ----
  catalogSchemaContext: { ja: 'catalog.schema コンテキスト', en: 'catalog.schema context' },
  selectContext: { ja: 'コンテキストを選択', en: 'Select context' },
  filterCatalogsSchemas: {
    ja: 'カタログ/スキーマを絞り込み…',
    en: 'Filter catalogs / schemas…',
  },
  recent: { ja: '最近使った', en: 'Recent' },
  catalogLabel: { ja: 'カタログ', en: 'Catalog' },
  schemaLabel: { ja: 'スキーマ', en: 'Schema' },
  failedToLoad: { ja: '読み込みに失敗しました。', en: 'Failed to load.' },
  noSchemas: { ja: 'スキーマがありません', en: 'No schemas' },

  // ---- UserChip ----
  currentIdentity: { ja: '現在のアイデンティティ', en: 'Current identity' },
  permissionsLabel: { ja: '権限', en: 'Permissions' },
  noPermissions: { ja: '権限がありません', en: 'No permissions' },
  datasourcesLabel: { ja: 'データソース', en: 'Datasources' },
  noDatasources: { ja: 'データソースがありません', en: 'No datasources' },
  githubLabel: { ja: 'GitHub', en: 'GitHub' },
  githubDisconnectedTitle: { ja: '連携を解除しました', en: 'Disconnected' },
  githubDisconnectedBody: {
    ja: 'GitHub アカウントの連携を解除しました。',
    en: 'GitHub account unlinked.',
  },
  disconnectButton: { ja: '連携解除', en: 'Disconnect' },
  disconnectFailedTitle: { ja: '連携解除に失敗しました', en: 'Disconnect failed' },

  // ---- NotebookTabs ----
  unsavedChanges: { ja: '未保存の変更', en: 'Unsaved changes' },
  browserRecoveryUnavailable: {
    ja: 'ブラウザー復旧利用不可',
    en: 'Browser recovery unavailable',
  },
  browserRecoveryUnavailableTitle: {
    ja: 'この編集内容はブラウザー内の復旧用ストレージに保存できませんでした。再読み込み前に保存してください。',
    en: 'This edit could not be stored in browser recovery storage. Save before reloading.',
  },
  saveConflict: { ja: '保存の競合', en: 'Notebook save conflict' },
  saveConflictTitle: {
    ja: 'サーバー側のバージョンが変更されています。「名前を付けて保存」でこのローカル版を保持してから、元のノートブックを再読み込みしてください。',
    en: 'The server version changed. Use Save as to preserve this local version, then reload the original notebook.',
  },
  closeTabAria: { ja: '{name} を閉じる', en: 'Close {name}' },
  renameNotebookAria: { ja: 'ノートブック名を変更', en: 'Rename notebook' },
  // タブの title 属性（複数の状態を連結して表示する）で使う短い接尾語群。
  tabUnsavedSuffix: { ja: '未保存', en: 'unsaved' },
  tabSaveConflictSuffix: { ja: '保存の競合', en: 'save conflict' },
  tabRecoveryUnavailableSuffix: {
    ja: 'ブラウザー復旧利用不可',
    en: 'browser recovery unavailable',
  },
  tabRenameHint: { ja: '（ダブルクリックで名前変更）', en: '(double-click to rename)' },

  // ---- DatasourceSelector ----
  dataSourceSelectorAria: { ja: 'データソース', en: 'Data source' },

  // ---- AppShell / App.tsx ----
  saveNotebookAsTitle: { ja: '名前を付けて保存', en: 'Save notebook as' },
  saveAsConfirmLabel: { ja: 'コピーを保存', en: 'Save a copy' },
  savedToastTitle: { ja: '保存しました', en: 'Saved' },
  loadingWorkspace: { ja: 'ワークスペースを読み込み中…', en: 'Loading workspace…' },

  // ---- Logo ----
  workbenchLabel: { ja: 'ワークベンチ', en: 'Workbench' },

  // ---- ShortcutsHelp ----
  macShortcutNote: {
    ja: 'macOS では、⌘ が Ctrl の代わりになります。実行、整形、保存はエディタ内からも使用できます。',
    en: 'On macOS, ⌘ stands in for Ctrl. Run, format and save also work from inside the editor.',
  },
  shortcutRunActiveCell: { ja: 'アクティブなセルを実行', en: 'Run the active cell' },
  shortcutSaveDocument: { ja: '現在のドキュメントを保存', en: 'Save current document' },
  shortcutFormatSqlAlt: { ja: 'SQL を整形（別ショートカット）', en: 'Format SQL (alternate)' },
  shortcutToggleTheme: { ja: 'ライト/ダークテーマを切り替え', en: 'Toggle light / dark theme' },
  shortcutTogglePresentation: {
    ja: 'プレゼンテーションモードを切り替え',
    en: 'Toggle presentation mode',
  },

  // ---- SearchInput ----
  searchPlaceholderDefault: { ja: '検索…', en: 'Search…' },
  clearSearchAria: { ja: '検索をクリア', en: 'Clear search' },
} as const);
