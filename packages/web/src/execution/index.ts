// Public surface of the execution layer (design.md §3, §5). Components and the
// editor wiring import from here rather than reaching into individual modules.

export {
  useExecutionStore,
  useCellExecution,
  executionActions,
  isCellRunning,
  __setEventSourceFactory,
  __setCellSettledSink,
  type CellExecution,
  type CellResultSummary,
  type ExecutionContext,
  type RunOptions,
  type ExecutionActions,
  type ResultRow,
} from './executionStore';
export {
  classifyStatement,
  isRowReturning,
  statementHasLimit,
  withAutoLimit,
  type StatementKind,
  type AutoLimitResult,
} from './sql';
export {
  allUnits,
  statementAtOffset,
  resolveExecution,
  type ExecutionUnit,
  type CaretSelection,
} from './executionUnit';
export { downloadCsvUrl, type DownloadFormat } from './api';
export { copyResultToClipboard, buildTsv, buildHtml } from './clipboard';
export { offsetToPosition, correctErrorPosition, type SourcePosition } from './errorOffset';
export {
  subscribeQueryEvents,
  type EventSourceLike,
  type EventSourceFactory,
  type SseSubscription,
} from './sse';
