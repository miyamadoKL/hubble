// Public surface of the notebook feature layer (design.md §4, §5). Components
// import from here rather than reaching into individual modules.

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
export { useNotebookWorkspace } from './useNotebookWorkspace';
export {
  runAllCells,
  runActiveSqlCell,
  isActiveNotebookRunning,
  cancelActiveNotebook,
  saveActiveNotebook,
} from './useNotebookActions';
export {
  detectVariables,
  inferType,
  reconcileVariables,
  substituteVariables,
  hasVariables,
  type DetectedVariable,
  type SubstitutionResult,
} from './variables';
export { insertAtActiveCursor, addSqlCellWithSource } from './insertActions';
export {
  readRecentContexts,
  recordRecentContext,
  pushRecent,
  sameContext,
  MAX_RECENT_CONTEXTS,
  RECENT_CONTEXTS_KEY,
  type ContextValue,
} from './recentContexts';
