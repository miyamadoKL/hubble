// Public surface of the notebook feature layer (design.md §4, §5). Components
// import from here rather than reaching into individual modules.
//
// ==== ファイルの責務（日本語） ================================================
// notebook 機能レイヤー（notebook 本体の状態管理、セル挿入操作、実行アクション、
// 変数、プレゼンテーションモード、最近使ったコンテキストなど）の公開 API を
// 集約する barrel ファイル。コンポーネントは個別モジュールへ直接アクセスせず、
// 必ずこの index からインポートする。
// ============================================================================

// notebookStore: notebook の CRUD、永続化、タブ管理を担う zustand ストアと、
// それを読む React フック、および純粋なヘルパー関数群。
export {
  useNotebookStore,
  useActiveNotebook,
  useNotebookTabs,
  persistNewNotebook,
  persistSavedNotebook,
  blankNotebook,
  recomputeVariables,
  moveItem,
  AUTOSAVE_DEBOUNCE_MS,
  __setPersistence,
  readWorkspaceSnapshot,
  readDrafts,
  type OpenNotebook,
  type NotebookPersistence,
} from './notebookStore';
// useNotebookWorkspace: アプリ起動時にワークスペース（開いていたタブ）を
// 復元する副作用フック。
export { useNotebookWorkspace } from './useNotebookWorkspace';
// useNotebookActions: TopBar/コマンドパレット/ショートカットから呼ばれる
// 命令的な notebook 操作（全セル実行や保存など）。
export {
  runAllCells,
  runActiveSqlCell,
  isActiveNotebookRunning,
  cancelActiveNotebook,
  saveActiveNotebook,
} from './useNotebookActions';
// variables: `${name}` 変数プレースホルダーの検出、型推論、置換。
export {
  detectVariables,
  inferType,
  reconcileVariables,
  substituteVariables,
  hasVariables,
  type DetectedVariable,
  type SubstitutionResult,
} from './variables';
// insertActions: Data browser / Saved queries / History パネルから SQL を
// notebook へ挿入するための命令的アクション。
export { insertAtActiveCursor, addSqlCellWithSource } from './insertActions';
// recentContexts: 直近使用した catalog.schema コンテキストの MRU リスト。
export {
  readRecentContexts,
  recordRecentContext,
  pushRecent,
  sameContext,
  MAX_RECENT_CONTEXTS,
  RECENT_CONTEXTS_KEY,
  type ContextValue,
} from './recentContexts';
