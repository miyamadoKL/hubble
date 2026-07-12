// SqlCell コンポーネント
// ノートブック内の1つのSQLセルを表現するコンポーネント。Monacoエディタを
// 実行ストア（executionストア）と結び付け、ステートメント単位のガター表示、
// 実行エラーマーカー、実行対象ユニット（選択範囲/カーソル位置/セル全体）の
// 解決までを一手に担う。Query Guardによるライブ見積り（コスト事前チェック）、
// EXPLAIN実行、実行結果表示（StatsStrip/ResultPane）などもこのファイルで統括する。
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as monaco from 'monaco-editor';
import type { CellResultMeta } from '@hubble/contracts';
import { CellToolbar } from './CellToolbar';
import { StatsStrip } from './StatsStrip';
import { EstimateStrip } from './EstimateStrip';
import { ResultPane } from './ResultPane';
import { LastRunStrip } from './LastRunStrip';
import { parseStatement } from '../../trino-lang';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { useEstimate } from '../../hooks/useEstimate';
import { useGuardConfig } from '../../hooks/useConfig';
import { Tooltip } from '../common/Tooltip';
import { Gauge } from 'lucide-react';
import {
  computeLiveEstimateTarget,
  estimatePresentation,
  setCellBlocked,
  clearCellBlock,
} from '../../execution';
import {
  applyStatementGutter,
  clearExecutionMarkers,
  computeGutterEntries,
  setExecutionMarkers,
  type StatementStatus,
} from '../../editor/executionGutter';
import {
  allUnits,
  classifyStatement,
  executionActions,
  isCellRunning,
  resolveExecution,
  statementAtOffset,
  useCellExecution,
  type ExecutionContext,
  type ExecutionUnit,
} from '../../execution';
import { cancelQuery, createQuery, fetchQueryRows } from '../../execution/api';
import { subscribeQueryEvents } from '../../execution/sse';
import { setActiveEditor, clearActiveEditor } from '../../editor/activeEditor';
import { ExplainQueryLifecycle } from './explainLifecycle';

const SqlEditor = lazy(() =>
  import('../../editor/SqlEditor').then((module) => ({ default: module.SqlEditor })),
);

/**
 * A live SQL cell: the Monaco editor wired to the execution store.
 * Owns the editor instance so it can paint the per-statement
 * gutter, push execution-error markers, and resolve the execution unit
 * (selection / caret / whole-cell) on run.
 *
 * Source edits flow up via `onSourceChange` (notebookStore is the source of
 * truth). Before any unit runs, its text is passed through `resolveUnit`, which
 * applies notebook variable substitution and can veto a run (returning null) —
 * 「実行時置換: runUnit/runUnits に渡す直前に解決」.
 */

/** SqlCell の props */
interface SqlCellProps {
  // セルの一意なID。実行ストア（useCellExecution）のキーとしても使う。
  cellId: string;
  // このセルのSQLソーステキスト（notebookStoreが真実の情報源）。
  source: string;
  // セルの表示名（任意）。
  name?: string;
  // セルが折りたたまれているかどうか。
  collapsed: boolean;
  /** Summary of the last persisted run, shown before this session re-runs it. */
  // 前回永続化された実行結果の要約。今セッションでまだ再実行していない場合に表示する。
  resultMeta?: CellResultMeta;
  // ソースが編集されたときに呼ばれるコールバック（親のnotebookStoreを更新する）。
  onSourceChange: (next: string) => void;
  // セルがフォーカスされたときに呼ばれるコールバック（任意）。
  onFocus?: () => void;
  // 実行時のカタログ/スキーマなどのコンテキスト情報。
  context: ExecutionContext;
  /** Default LIMIT from /api/config. */
  // /api/config から取得したデフォルトのLIMIT値。
  defaultLimit: number;
  /** false のとき Query Guard 見積りを行わない（costEstimate 非対応データソース）。 */
  costEstimateEnabled?: boolean;
  /** false のとき Monaco 標準 SQL モードを使う（Trino ANTLR を無効化）。 */
  trinoLanguage?: boolean;
  /**
   * Resolve a unit's statement before it runs (variable substitution). Returns a
   * unit with substituted text, or null to abort the run (missing variables).
   */
  // 実行ユニットが走る直前に変数置換を行う関数。置換済みユニットを返すか、
  // 変数が解決できない等の理由で実行を中止する場合はnullを返す。
  resolveUnit: (unit: ExecutionUnit) => ExecutionUnit | null;
  /** Notebook variable values (name → value) for live-estimate substitution. */
  // ライブ見積り（Query Guard）用の変数置換に使う、ノートブック変数の値（名前→値）。
  variableValues: Record<string, string>;
  /** Cell-chrome handlers (collapse / move / delete / rename / grip). */
  // セルの外枠（折りたたみ、移動、削除、リネーム、ドラッグハンドル）に関するハンドラー群。
  chrome: SqlCellChrome;
}

/** Notebook-level cell-chrome handlers passed down from NotebookView. */
/**
 * NotebookViewから渡される、セルの外枠（chrome）操作に関するハンドラー群の型。
 * 折りたたみ、上下移動、削除、リネーム、ドラッグ操作などをまとめて表す。
 */
export interface SqlCellChrome {
  // これ以上上に移動できない場合はfalse。
  canMoveUp: boolean;
  // これ以上下に移動できない場合はfalse。
  canMoveDown: boolean;
  // 折りたたみ状態をトグルするハンドラー。
  onToggleCollapse: () => void;
  // セル名を変更するハンドラー。
  onRename: (name: string) => void;
  // セルを1つ上に移動するハンドラー。
  onMoveUp: () => void;
  // セルを1つ下に移動するハンドラー。
  onMoveDown: () => void;
  // セルを削除するハンドラー。
  onDelete: () => void;
  // ドラッグ&ドロップの取っ手（grip）に付与するprops（任意）。
  dragHandleProps?: React.HTMLAttributes<HTMLSpanElement>;
}

/** Debounce after editing stops before fetching a live estimate (Query Guard). */
// 編集停止後、ライブ見積り（Query Guard）を取得するまでのデバウンス時間（ミリ秒）。
const ESTIMATE_DEBOUNCE_MS = 600;

/**
 * 複数の実行単位をすべて解決し、1 件でも失敗した場合は batch 全体を中止する。
 *
 * @param units 解決前の実行単位。
 * @param resolveUnit 変数置換などを適用する解決関数。
 * @returns 全件の解決結果。1 件でも解決できなければ null。
 */
export function resolveAllExecutionUnits(
  units: ExecutionUnit[],
  resolveUnit: (unit: ExecutionUnit) => ExecutionUnit | null,
): ExecutionUnit[] | null {
  const resolved: ExecutionUnit[] = [];
  for (const unit of units) {
    const next = resolveUnit(unit);
    if (!next) return null;
    resolved.push(next);
  }
  return resolved;
}

/**
 * ライブSQLセル本体のコンポーネント。Monacoエディタのインスタンスを保持し、
 * ステートメント単位のガター描画、実行エラーマーカー、実行ユニットの解決を
 * 行い、実行結果（StatsStrip / ResultPane）や見積りストリップ（EstimateStrip）を
 * 表示する。
 */
export function SqlCell({
  cellId,
  source,
  name,
  collapsed,
  resultMeta,
  onSourceChange,
  onFocus,
  context,
  defaultLimit,
  costEstimateEnabled = true,
  trinoLanguage = true,
  resolveUnit,
  variableValues,
  chrome,
}: SqlCellProps) {
  // Query Guard機能のグローバル設定（mode等）を取得する。
  const guard = useGuardConfig();
  // LIMIT句を自動付与するかどうかのトグル状態。
  const [autoLimit, setAutoLimit] = useState(true);
  // 自動LIMIT時に使う行数上限（初期値はdefaultLimit）。
  const [limit, setLimit] = useState(defaultLimit);
  // エディタ内のカーソル位置（文字オフセット）。ガター描画対象ステートメントの判定に使う。
  const [caretOffset, setCaretOffset] = useState(0);
  // The current selection span (anchor/active), tracked so the live estimate
  // targets the exact unit Ctrl/Cmd+Enter would run (selection → caret stmt).
  // 現在の選択範囲（起点/現在位置）。ライブ見積りがCtrl/Cmd+Enterで実行される
  // ユニットと完全に一致するよう、この情報を追跡している。
  const [selection, setSelection] = useState<{ anchor: number; active: number }>({
    anchor: 0,
    active: 0,
  });

  // EXPLAIN runs as a side query (not stored per-cell, to keep the cell record
  // about the main result). We manage its lifecycle locally.
  // EXPLAINは副問い合わせとして実行され、セルの実行レコードには保存しない
  // （メインの結果に専念させるため）。そのためライフサイクルをこのコンポーネント内で
  // ローカルに管理する。
  // EXPLAIN結果のプレーンテキスト（未実行ならundefined）。
  const [explainText, setExplainText] = useState<string | undefined>(undefined);
  // EXPLAINクエリが実行中かどうか。
  const [explainRunning, setExplainRunning] = useState(false);
  // EXPLAIN副問い合わせのqueryId、世代、購読、終端を所有するコントローラー。
  const explainLifecycleRef = useRef<ExplainQueryLifecycle | null>(null);
  if (explainLifecycleRef.current === null) {
    explainLifecycleRef.current = new ExplainQueryLifecycle({
      createQuery,
      cancelQuery,
      fetchQueryRows,
      subscribeQueryEvents,
    });
  }

  /** 現在のEXPLAINを停止し、表示状態を未実行へ戻す。 */
  const resetExplain = useCallback(() => {
    explainLifecycleRef.current?.cancelCurrent();
    setExplainRunning(false);
    setExplainText(undefined);
  }, []);

  // Monacoエディタのインスタンス本体への参照。
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  // Monaco名前空間（monaco-editorモジュール）への参照。
  const monacoRef = useRef<typeof monaco | null>(null);
  // ガター（行番号脇のステータスアイコン等）の装飾コレクションへの参照。
  const gutterRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);

  // このセルの実行状態レコード（実行ストアから取得）。
  const exec = useCellExecution(cellId);
  // このセルが現在実行中（queued/running）かどうか。
  const running = isCellRunning(exec);

  // Map the cell's batch/error state onto per-statement gutter statuses, keyed
  // by each statement's start offset.
  // セルの実行状態（実行中/失敗/完了）を、実行対象ステートメントの開始オフセットを
  // キーとするガター表示ステータスのマップに変換する。
  const statusByStart = useCallback((): Map<number, StatementStatus> => {
    const map = new Map<number, StatementStatus>();
    if (!exec) return map;
    // 実行対象だったユニットの開始オフセット。
    const start = exec.unitStart;
    let status: StatementStatus = 'idle';
    // 実行状態に応じてガターに出すステータスを決定する。
    if (isCellRunning(exec)) status = 'executing';
    else if (exec.state === 'failed') status = 'failed';
    else if (exec.state === 'finished') status = 'done';
    map.set(start, status);
    return map;
  }, [exec]);

  // Repaint the gutter whenever the source, caret, or execution state changes.
  // ソース、カーソル位置、実行状態のいずれかが変わるたびにガターを再描画する。
  useEffect(() => {
    const editor = editorRef.current;
    const monacoNs = monacoRef.current;
    const collection = gutterRef.current;
    if (!editor || !monacoNs || !collection) return;
    const model = editor.getModel();
    if (!model) return;
    // ソース、カーソル位置、ステータスマップからガターに描画するエントリを計算し、
    // Monacoの装飾コレクションに適用する。
    const entries = computeGutterEntries(source, caretOffset, statusByStart());
    applyStatementGutter(monacoNs, model, collection, entries);
  }, [source, caretOffset, statusByStart]);

  // Push / clear execution-error markers as the cell's error changes.
  // セルのエラー状態が変わるたびに、エディタ上のエラーマーカーを設置/クリアする。
  useEffect(() => {
    const editor = editorRef.current;
    const monacoNs = monacoRef.current;
    if (!editor || !monacoNs) return;
    const model = editor.getModel();
    if (!model) return;
    // エラーがあればそのエラー内容をステートメント開始位置に紐付けてマーカー表示、
    // なければ既存のマーカーをクリアする。
    if (exec?.error) setExecutionMarkers(monacoNs, model, exec.error, exec.unitStart);
    else clearExecutionMarkers(monacoNs, model);
  }, [exec?.error, exec?.unitStart]);

  // アンマウント時にEXPLAINの購読とサーバー側queryを停止するクリーンアップ。
  useEffect(
    () => () => {
      explainLifecycleRef.current?.dispose();
      explainLifecycleRef.current = null;
    },
    [],
  );

  // Stop being the Data browser's insert target once this cell unmounts.
  // アンマウント時、このセルがData browserの挿入先ターゲットだった場合は解除する。
  useEffect(() => () => clearActiveEditor(cellId), [cellId]);

  // Edits invalidate any computed EXPLAIN plan (it would be stale). Reset it in
  // the change handler rather than an effect to avoid a cascading render.
  // ソース編集時のハンドラー。ソースが変わるとそれまで計算していたEXPLAINプランは
  // 古くなるため破棄する（連鎖的な再レンダリングを避けるため、effectではなく
  // このハンドラー内でリセットしている）。
  const handleChange = useCallback(
    (next: string) => {
      onSourceChange(next);
      resetExplain();
    },
    [onSourceChange, resetExplain],
  );

  // 実行時に渡すオプション（自動LIMITのオン/オフとLIMIT値）をまとめたオブジェクト。
  const runOpts = { autoLimit, limit };

  // ---- Query Guard live estimate (Query Guard feature) ----------------------
  // Debounce edits/caret moves ~600ms, then estimate the statement the run unit
  // would send — but only when the cell parses clean, all variables resolve, and
  // the guard is on. The resolved statement is byte-identical to the run path's,
  // so it hits the server's estimate cache and the run-time block is consistent.
  // ソースと選択範囲をそれぞれデバウンスして、編集中に見積りリクエストを連発しないようにする。
  const debouncedSource = useDebouncedValue(source, ESTIMATE_DEBOUNCE_MS);
  const debouncedSelection = useDebouncedValue(selection, ESTIMATE_DEBOUNCE_MS);

  // デバウンス後の状態から、見積り対象（実行されるであろうステートメント）を算出する。
  // parsesClean は構文エラーが無いかを判定するコールバック。
  const target = useMemo(() => {
    if (!costEstimateEnabled) {
      return { estimate: false, reason: 'guard-off' as const };
    }
    return computeLiveEstimateTarget({
      source: debouncedSource,
      selection: debouncedSelection,
      variableValues,
      autoLimit,
      limit,
      guardMode: guard.mode,
      parsesClean: (sql) =>
        trinoLanguage
          ? parseStatement(sql, context.catalog, context.schema).markers.length === 0
          : sql.trim().length > 0,
    });
  }, [
    costEstimateEnabled,
    debouncedSource,
    debouncedSelection,
    variableValues,
    autoLimit,
    limit,
    guard.mode,
    context.catalog,
    context.schema,
    trinoLanguage,
  ]);

  // 見積りを行うべきステートメント（不要ならnullでフックにリクエストさせない）。
  const estimateStatement = target.estimate && 'statement' in target ? target.statement : null;
  // 実際にサーバーへ見積りを問い合わせるReact Queryフック。
  const estimateQuery = useEstimate({
    statement: estimateStatement,
    catalog: context.catalog,
    schema: context.schema,
    datasourceId: context.datasourceId,
    enabled: costEstimateEnabled,
  });

  // Derive the strip presentation; only show it when we actually estimated.
  // 見積りストリップ（EstimateStrip）に渡す表示用データを算出する。
  // 実際に見積りを取得した場合のみ表示する。
  const presentation = useMemo(() => {
    if (!target.estimate || !estimateQuery.data) {
      return { visible: false } as ReturnType<typeof estimatePresentation>;
    }
    return estimatePresentation(estimateQuery.data);
  }, [target.estimate, estimateQuery.data]);

  // Publish the block to the registry so run-all / palette / shortcuts honor it.
  // このセルがブロック（見積り結果によりQuery Guardで実行禁止）されているかどうか。
  const blocked = presentation.visible && presentation.blocked;
  // ブロック状態をグローバルなレジストリに登録する。「全セル実行」やコマンドパレット、
  // ショートカットなど、このコンポーネント外からもブロック状態を参照できるようにするため。
  useEffect(() => {
    setCellBlocked(cellId, blocked ? { reasons: presentation.reasons } : undefined);
  }, [cellId, blocked, presentation.reasons]);
  // アンマウント時にブロック登録を解除するクリーンアップ。
  useEffect(() => () => clearCellBlock(cellId), [cellId]);

  // `handleReady` runs once on editor mount, so its event handlers must read the
  // latest context / run options / resolver through a ref rather than the
  // captured-at-mount closure. The ref is updated in an effect, never in render.
  // handleReadyはエディタマウント時に一度だけ実行されるため、その中のイベント
  // ハンドラーはマウント時にキャプチャされたクロージャではなく、refを介して
  // 常に最新のcontext/runOpts/resolveUnitを参照する必要がある。このrefは
  // レンダー中ではなくeffect内でのみ更新する。
  const runConfigRef = useRef({ context, runOpts, resolveUnit });
  useEffect(() => {
    runConfigRef.current = { context, runOpts, resolveUnit };
  });

  // The editor-mounted run handlers (gutter click, Ctrl/Cmd+Enter) must see the
  // current block state too, so mirror it into a ref.
  // エディタにマウントされた実行系ハンドラー（ガタークリック、Ctrl/Cmd+Enter）も
  // 最新のブロック状態を参照する必要があるため、refにミラーリングする。
  const blockedRef = useRef(blocked);
  useEffect(() => {
    blockedRef.current = blocked;
  });

  /** Run a single unit after variable substitution (null = aborted). */
  /** 単一の実行ユニットを、変数置換を経てから実行する（置換失敗＝nullなら中止）。 */
  const runOne = (unit: ExecutionUnit, cfg = runConfigRef.current) => {
    const resolved = cfg.resolveUnit(unit);
    if (!resolved) return;
    resetExplain();
    executionActions().runUnit(cellId, resolved, cfg.context, cfg.runOpts);
  };

  /**
   * 旧コメント「Run several units sequentially after substituting each (abort drops it).」は、
   * 各実行ユニットを置換し、失敗したユニットだけを除外して残りを順次実行する挙動を示していた。
   * 現在は全件を実行前に解決し、1 件でも失敗した場合はbatch全体を中止する。
   */
  const runMany = (units: ExecutionUnit[], cfg = runConfigRef.current) => {
    const resolved = resolveAllExecutionUnits(units, cfg.resolveUnit);
    if (!resolved || resolved.length === 0) return;
    resetExplain();
    if (resolved.length === 1)
      executionActions().runUnit(cellId, resolved[0]!, cfg.context, cfg.runOpts);
    else void executionActions().runUnits(cellId, resolved, cfg.context, cfg.runOpts);
  };

  // Monacoエディタのマウント完了時に呼ばれるコールバック。エディタ、Monaco名前空間、
  // ガター装飾コレクションをrefに保存し、各種イベントリスナーを登録する。
  const handleReady = (editor: monaco.editor.IStandaloneCodeEditor, monacoNs: typeof monaco) => {
    editorRef.current = editor;
    monacoRef.current = monacoNs;
    gutterRef.current = editor.createDecorationsCollection([]);

    // 初期カーソル位置をオフセットに変換してstateに反映する。
    const model = editor.getModel();
    setCaretOffset(
      model ? model.getOffsetAt(editor.getPosition() ?? { lineNumber: 1, column: 1 }) : 0,
    );

    // カーソル位置が変わるたびにcaretOffsetを更新する（ガター再描画のトリガーにもなる）。
    editor.onDidChangeCursorPosition((e) => {
      const m = editor.getModel();
      if (m) setCaretOffset(m.getOffsetAt(e.position));
    });

    // Track the selection span so the live estimate mirrors the run unit
    // (a non-empty selection runs that text; otherwise the caret statement).
    editor.onDidChangeCursorSelection((e) => {
      const m = editor.getModel();
      if (!m) return;
      const sel = e.selection;
      setSelection({
        anchor: m.getOffsetAt({
          lineNumber: sel.selectionStartLineNumber,
          column: sel.selectionStartColumn,
        }),
        active: m.getOffsetAt({ lineNumber: sel.positionLineNumber, column: sel.positionColumn }),
      });
    });

    // エディタがフォーカスされたときの処理。親へフォーカス通知するとともに、
    // Data browserからのカラム挿入先としてこのエディタを登録する。
    editor.onDidFocusEditorText(() => {
      onFocus?.();
      // Register as the Data browser's insert target while focused.
      setActiveEditor(cellId, editor);
    });

    // Click a statement's gutter glyph → run just that statement.
    // ガター（行番号脇）のグリフをクリックしたときの処理:
    // クリックされた行に対応するステートメントだけを実行する。
    editor.onMouseDown((e) => {
      if (e.target.type !== monacoNs.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
      const lineNumber = e.target.position?.lineNumber;
      const m = editor.getModel();
      if (!lineNumber || !m) return;
      const offset = m.getOffsetAt({ lineNumber, column: 1 });
      const unit = statementAtOffset(m.getValue(), offset);
      if (unit) runOne(unit);
    });
  };

  // Ctrl/Cmd+Enter: selection → that text; else statement under the caret.
  // Ctrl/Cmd+Enterのショートカットハンドラー: 選択範囲があればその範囲のテキストを、
  // なければカーソル位置のステートメントを実行対象として解決し実行する。
  const handleExecute = (editor: monaco.editor.IStandaloneCodeEditor) => {
    // Query Guard: the run unit is blocked — the server would 422, so don't even
    // start (the strip shows why). enforce is still the real wall.
    // Query Guardによりブロックされている場合はサーバーに送っても422になるだけなので、
    // ここで実行を始めない（理由はストリップ上に表示される）。ただし実際の防波堤は
    // サーバー側のenforceであることに注意。
    if (blockedRef.current) return;
    const model = editor.getModel();
    if (!model) return;
    const sel = editor.getSelection();
    const anchor = sel
      ? model.getOffsetAt({
          lineNumber: sel.selectionStartLineNumber,
          column: sel.selectionStartColumn,
        })
      : 0;
    const active = sel
      ? model.getOffsetAt({ lineNumber: sel.positionLineNumber, column: sel.positionColumn })
      : 0;
    // 選択範囲/カーソル位置から実際に実行すべきユニット（ステートメント群）を解決する。
    const units = resolveExecution(model.getValue(), { anchor, active });
    if (units.length === 1) runOne(units[0]!);
    else if (units.length > 1) runMany(units);
  };

  // Toolbar "run cell" → every statement, sequentially.
  // ツールバーの「セル実行」ボタンのハンドラー: セル内の全ステートメントを順に実行する。
  const runWholeCell = () => {
    // Query Guard: the caret statement is blocked — disable the whole-cell run
    // too (the button is also visually disabled). enforce is the real wall.
    // カーソル位置のステートメントがブロックされている場合、セル全体の実行も
    // 無効化する（ボタン自体も見た目上disabledになっている）。ここでも実際の
    // 防波堤はサーバー側のenforce。
    if (blocked) return;
    const units = allUnits(source);
    if (units.length === 0) return;
    if (units.length === 1) runOne(units[0]!);
    else runMany(units);
  };

  // 実行中のクエリをキャンセルするハンドラー。
  const cancel = () => {
    void executionActions()
      .cancel(cellId)
      .catch(() => undefined);
  };

  // EXPLAIN the statement under the caret as a one-off query, streamed in.
  // カーソル位置のステートメントに対してEXPLAINを単発クエリとして実行し、
  // 結果をSSEでストリーミング受信するハンドラー。
  const runExplain = useCallback(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    const src = model?.getValue() ?? source;
    const offset = caretOffset;
    // カーソル位置のステートメントを取得。取れなければ先頭のステートメントにフォールバック。
    const baseUnit = statementAtOffset(src, offset) ?? allUnits(src)[0];
    if (!baseUnit) return;
    // Substitute variables in the EXPLAIN target too.
    // EXPLAIN対象にも通常実行と同様に変数置換を適用する。
    const unit = runConfigRef.current.resolveUnit(baseUnit);
    if (!unit) return;
    const kind = classifyStatement(unit.text);
    // Don't double-EXPLAIN an EXPLAIN.
    // 対象が既にEXPLAIN文の場合は二重にEXPLAINしない。
    const statement = kind === 'explain' ? unit.text : `EXPLAIN ${unit.text}`;

    // コントローラーが旧世代を停止し、遅延応答を現在世代だけへ反映する。
    explainLifecycleRef.current?.start(
      {
        statement,
        catalog: context.catalog,
        schema: context.schema,
        datasourceId: context.datasourceId,
      },
      { setText: setExplainText, setRunning: setExplainRunning },
    );
  }, [source, caretOffset, context.catalog, context.schema, context.datasourceId]);

  /** セル削除前にEXPLAIN副問い合わせの所有権を解放する。 */
  const deleteCell = () => {
    resetExplain();
    chrome.onDelete();
  };

  return (
    <div>
      {/* セル上部のツールバー: 名前、折りたたみ、実行/キャンセル、LIMIT設定、並び替え、削除など。 */}
      <CellToolbar
        kind="sql"
        name={name}
        collapsed={collapsed}
        running={running}
        autoLimit={autoLimit}
        limit={limit}
        canMoveUp={chrome.canMoveUp}
        canMoveDown={chrome.canMoveDown}
        onToggleCollapse={chrome.onToggleCollapse}
        onRename={chrome.onRename}
        onRun={runWholeCell}
        onCancel={cancel}
        runDisabled={blocked}
        runDisabledReason={blocked ? presentation.reasons[0] : undefined}
        onToggleAutoLimit={() => setAutoLimit((v) => !v)}
        onLimitChange={setLimit}
        onMoveUp={chrome.onMoveUp}
        onMoveDown={chrome.onMoveDown}
        onDelete={deleteCell}
        dragHandleProps={chrome.dragHandleProps}
      />
      {/* 折りたたまれていない場合のみ、エディタ本体と結果表示エリアをレンダリングする。 */}
      {!collapsed && (
        <>
          {/* Monaco SQLエディタ本体。 */}
          <div className="bg-surface-raised">
            <Suspense
              fallback={
                <div className="flex h-24 items-center justify-center text-xs text-ink-muted">
                  Loading editor…
                </div>
              }
            >
              <SqlEditor
                value={source}
                onChange={handleChange}
                onExecute={handleExecute}
                onReady={handleReady}
                trinoLanguage={trinoLanguage}
                ariaLabel={`SQL cell ${name ?? ''}`}
              />
            </Suspense>
          </div>
          {!costEstimateEnabled && (
            <Tooltip label="This data source does not support scan estimates">
              <div className="flex items-center gap-1.5 border-b border-border-subtle bg-surface-inset px-3 py-1 font-mono text-2xs text-ink-subtle">
                <Gauge size={12} strokeWidth={1.75} className="shrink-0 opacity-50" />
                Estimate unavailable for this data source
              </div>
            </Tooltip>
          )}
          {/* Query Guardのライブ見積りストリップ。見積りが取得できた場合のみ表示する。 */}
          {costEstimateEnabled && presentation.visible && (
            <div className="border-b border-border-subtle bg-surface-raised">
              <EstimateStrip presentation={presentation} loading={estimateQuery.isFetching} />
            </div>
          )}
          {/* このセッションで実行された実行レコード(exec)があれば、その統計と結果を表示。 */}
          {exec ? (
            <>
              <StatsStrip
                state={exec.state}
                stats={exec.stats}
                infoUri={exec.infoUri}
                loadedRows={exec.rows.length}
                truncated={exec.truncated}
                onCancel={cancel}
              />
              <ResultPane
                cellId={cellId}
                cell={exec}
                explainText={explainText}
                explainRunning={explainRunning}
                onExplain={runExplain}
              />
            </>
          ) : (
            // No live result this session — surface the last persisted run, if any
            // (再ロード時に「前回実行」を表示).
            // このセッションではまだ実行していない場合、永続化された前回の実行結果概要が
            // あればそれを表示する。
            resultMeta && <LastRunStrip meta={resultMeta} onRun={runWholeCell} />
          )}
        </>
      )}
    </div>
  );
}
