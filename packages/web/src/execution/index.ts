// Public surface of the execution layer. Components and the
// editor wiring import from here rather than reaching into individual modules.
//
// ==== ファイルの責務（日本語） ================================================
// execution レイヤー（クエリ実行の状態管理、SQL 解析、見積り、SSE、
// クリップボード、エラー座標補正など）の公開 API を集約する barrel ファイル。
// コンポーネントやエディタ側の配線コードは、個別モジュールへ直接アクセスせず
// 必ずこの index からインポートする（内部モジュール構成を自由に変更できる
// ようにするため）。
// ============================================================================

// executionStore: セル単位のクエリ実行状態を管理する zustand ストアと、
// それを読むための React フック群。
export {
  useExecutionStore,
  useCellExecution,
  executionActions,
  isCellRunning,
  __setEventSourceFactory,
  __setCellSettledSink,
  hasAttemptedRestore,
  markRestoreAttempted,
  clearRestoreAttemptsForCells,
  type CellExecution,
  type CellResultSummary,
  type ExecutionContext,
  type RunOptions,
  type ExecutionActions,
  type ResultRow,
} from './executionStore';
// sql: ステートメント種別の判定、LIMIT 有無の検出、auto-LIMIT の付与といった
// 純粋な SQL テキスト処理。
export {
  classifyStatement,
  isRowReturning,
  statementHasLimit,
  withAutoLimit,
  type StatementKind,
  type AutoLimitResult,
} from './sql';
// executionUnit: キャレット位置/選択範囲から「何を実行するか（実行単位）」を
// 決定するロジック。
export {
  allUnits,
  statementAtOffset,
  resolveExecution,
  type ExecutionUnit,
  type CaretSelection,
} from './executionUnit';
// estimate: Query Guard の見積り取得、実行前チェック、UI 表示用の変換。
export {
  estimateQuery,
  resolveEstimateInput,
  computeLiveEstimateTarget,
  estimatePresentation,
  parseQueryBlocked,
  isQueryBlocked,
  type ResolveEstimateInput,
  type ResolveEstimateResult,
  type LiveEstimateInput,
  type LiveEstimateTarget,
  type LiveEstimateSkip,
  type EstimatePresentation,
  type EstimateTone,
  type QueryBlockedDetails,
} from './estimate';
// guardRegistry: セルごとの Query Guard ブロック状態を共有するレジストリ。
export {
  setCellBlocked,
  getCellBlock,
  isCellBlocked,
  clearCellBlock,
  type CellBlock,
} from './guardRegistry';
// api: クエリのライフサイクルに関する型付き API ラッパー。
export { downloadCsvUrl, downloadXlsxUrl, exportQuery, type DownloadFormat } from './api';
// clipboard: 結果グリッドの TSV/HTML クリップボードコピー。
export { copyResultToClipboard, buildTsv, buildHtml } from './clipboard';
// errorOffset: ステートメント相対のエラー座標をセル全体のソース座標へ補正する。
export { offsetToPosition, correctErrorPosition, type SourcePosition } from './errorOffset';
// sse: クエリイベントの Server-Sent Events 購読。
export {
  subscribeQueryEvents,
  type EventSourceLike,
  type EventSourceFactory,
  type SseSubscription,
} from './sse';
