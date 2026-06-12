import { useCallback, useEffect, useRef, useState } from 'react';
import type * as monaco from 'monaco-editor';
import type { CellResultMeta } from '@hue-fable/contracts';
import { SqlEditor } from '../../editor/SqlEditor';
import { CellToolbar } from './CellToolbar';
import { StatsStrip } from './StatsStrip';
import { ResultPane } from './ResultPane';
import { LastRunStrip } from './LastRunStrip';
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
import {
  createQuery,
  fetchQueryRows,
} from '../../execution/api';
import { subscribeQueryEvents } from '../../execution/sse';
import { setActiveEditor, clearActiveEditor } from '../../editor/activeEditor';

/**
 * A live SQL cell: the Monaco editor wired to the execution store
 * (design.md §5). Owns the editor instance so it can paint the per-statement
 * gutter, push execution-error markers, and resolve the execution unit
 * (selection / caret / whole-cell) on run.
 *
 * Source edits flow up via `onSourceChange` (notebookStore is the source of
 * truth). Before any unit runs, its text is passed through `resolveUnit`, which
 * applies notebook variable substitution and can veto a run (returning null) —
 * design.md §5 「実行時置換: runUnit/runUnits に渡す直前に解決」.
 */

interface SqlCellProps {
  cellId: string;
  source: string;
  name?: string;
  collapsed: boolean;
  /** Summary of the last persisted run, shown before this session re-runs it. */
  resultMeta?: CellResultMeta;
  onSourceChange: (next: string) => void;
  onFocus?: () => void;
  context: ExecutionContext;
  /** Default LIMIT from /api/config (design.md §5). */
  defaultLimit: number;
  /**
   * Resolve a unit's statement before it runs (variable substitution). Returns a
   * unit with substituted text, or null to abort the run (missing variables).
   */
  resolveUnit: (unit: ExecutionUnit) => ExecutionUnit | null;
  /** Cell-chrome handlers (collapse / move / delete / rename / grip). */
  chrome: SqlCellChrome;
}

/** Notebook-level cell-chrome handlers passed down from NotebookView. */
export interface SqlCellChrome {
  canMoveUp: boolean;
  canMoveDown: boolean;
  onToggleCollapse: () => void;
  onRename: (name: string) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
  dragHandleProps?: React.HTMLAttributes<HTMLSpanElement>;
}

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
  resolveUnit,
  chrome,
}: SqlCellProps) {
  const [autoLimit, setAutoLimit] = useState(true);
  const [limit, setLimit] = useState(defaultLimit);
  const [caretOffset, setCaretOffset] = useState(0);

  // EXPLAIN runs as a side query (not stored per-cell, to keep the cell record
  // about the main result). We manage its lifecycle locally.
  const [explainText, setExplainText] = useState<string | undefined>(undefined);
  const [explainRunning, setExplainRunning] = useState(false);
  const explainSubRef = useRef<{ close: () => void } | null>(null);

  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof monaco | null>(null);
  const gutterRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);

  const exec = useCellExecution(cellId);
  const running = isCellRunning(exec);

  // Map the cell's batch/error state onto per-statement gutter statuses, keyed
  // by each statement's start offset.
  const statusByStart = useCallback((): Map<number, StatementStatus> => {
    const map = new Map<number, StatementStatus>();
    if (!exec) return map;
    const start = exec.unitStart;
    let status: StatementStatus = 'idle';
    if (isCellRunning(exec)) status = 'executing';
    else if (exec.state === 'failed') status = 'failed';
    else if (exec.state === 'finished') status = 'done';
    map.set(start, status);
    return map;
  }, [exec]);

  // Repaint the gutter whenever the source, caret, or execution state changes.
  useEffect(() => {
    const editor = editorRef.current;
    const monacoNs = monacoRef.current;
    const collection = gutterRef.current;
    if (!editor || !monacoNs || !collection) return;
    const model = editor.getModel();
    if (!model) return;
    const entries = computeGutterEntries(source, caretOffset, statusByStart());
    applyStatementGutter(monacoNs, model, collection, entries);
  }, [source, caretOffset, statusByStart]);

  // Push / clear execution-error markers as the cell's error changes.
  useEffect(() => {
    const editor = editorRef.current;
    const monacoNs = monacoRef.current;
    if (!editor || !monacoNs) return;
    const model = editor.getModel();
    if (!model) return;
    if (exec?.error) setExecutionMarkers(monacoNs, model, exec.error, exec.unitStart);
    else clearExecutionMarkers(monacoNs, model);
  }, [exec?.error, exec?.unitStart]);

  useEffect(() => () => explainSubRef.current?.close(), []);

  // Stop being the Data browser's insert target once this cell unmounts.
  useEffect(() => () => clearActiveEditor(cellId), [cellId]);

  // Edits invalidate any computed EXPLAIN plan (it would be stale). Reset it in
  // the change handler rather than an effect to avoid a cascading render.
  const handleChange = useCallback(
    (next: string) => {
      onSourceChange(next);
      setExplainText(undefined);
      explainSubRef.current?.close();
      explainSubRef.current = null;
    },
    [onSourceChange],
  );

  const runOpts = { autoLimit, limit };

  // `handleReady` runs once on editor mount, so its event handlers must read the
  // latest context / run options / resolver through a ref rather than the
  // captured-at-mount closure. The ref is updated in an effect, never in render.
  const runConfigRef = useRef({ context, runOpts, resolveUnit });
  useEffect(() => {
    runConfigRef.current = { context, runOpts, resolveUnit };
  });

  /** Run a single unit after variable substitution (null = aborted). */
  const runOne = (unit: ExecutionUnit, cfg = runConfigRef.current) => {
    const resolved = cfg.resolveUnit(unit);
    if (!resolved) return;
    executionActions().runUnit(cellId, resolved, cfg.context, cfg.runOpts);
  };

  /** Run several units sequentially after substituting each (abort drops it). */
  const runMany = (units: ExecutionUnit[], cfg = runConfigRef.current) => {
    const resolved = units
      .map((u) => cfg.resolveUnit(u))
      .filter((u): u is ExecutionUnit => u !== null);
    if (resolved.length === 0) return;
    if (resolved.length === 1) executionActions().runUnit(cellId, resolved[0]!, cfg.context, cfg.runOpts);
    else void executionActions().runUnits(cellId, resolved, cfg.context, cfg.runOpts);
  };

  const handleReady = (
    editor: monaco.editor.IStandaloneCodeEditor,
    monacoNs: typeof monaco,
  ) => {
    editorRef.current = editor;
    monacoRef.current = monacoNs;
    gutterRef.current = editor.createDecorationsCollection([]);

    const model = editor.getModel();
    setCaretOffset(model ? model.getOffsetAt(editor.getPosition() ?? { lineNumber: 1, column: 1 }) : 0);

    editor.onDidChangeCursorPosition((e) => {
      const m = editor.getModel();
      if (m) setCaretOffset(m.getOffsetAt(e.position));
    });

    editor.onDidFocusEditorText(() => {
      onFocus?.();
      // Register as the Data browser's insert target while focused.
      setActiveEditor(cellId, editor);
    });

    // Click a statement's gutter glyph → run just that statement.
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
  const handleExecute = (editor: monaco.editor.IStandaloneCodeEditor) => {
    const model = editor.getModel();
    if (!model) return;
    const sel = editor.getSelection();
    const anchor = sel
      ? model.getOffsetAt({ lineNumber: sel.selectionStartLineNumber, column: sel.selectionStartColumn })
      : 0;
    const active = sel
      ? model.getOffsetAt({ lineNumber: sel.positionLineNumber, column: sel.positionColumn })
      : 0;
    const units = resolveExecution(model.getValue(), { anchor, active });
    if (units.length === 1) runOne(units[0]!);
    else if (units.length > 1) runMany(units);
  };

  // Toolbar "run cell" → every statement, sequentially.
  const runWholeCell = () => {
    const units = allUnits(source);
    if (units.length === 0) return;
    if (units.length === 1) runOne(units[0]!);
    else runMany(units);
  };

  const cancel = () => executionActions().cancel(cellId);

  // EXPLAIN the statement under the caret as a one-off query, streamed in.
  const runExplain = useCallback(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    const src = model?.getValue() ?? source;
    const offset = caretOffset;
    const baseUnit = statementAtOffset(src, offset) ?? allUnits(src)[0];
    if (!baseUnit) return;
    // Substitute variables in the EXPLAIN target too.
    const unit = runConfigRef.current.resolveUnit(baseUnit);
    if (!unit) return;
    const kind = classifyStatement(unit.text);
    // Don't double-EXPLAIN an EXPLAIN.
    const statement = kind === 'explain' ? unit.text : `EXPLAIN ${unit.text}`;

    setExplainRunning(true);
    setExplainText(undefined);
    explainSubRef.current?.close();

    createQuery({ statement, catalog: context.catalog, schema: context.schema })
      .then(({ queryId }) => {
        explainSubRef.current = subscribeQueryEvents(queryId, {
          onEvent: (event) => {
            if (event.type === 'done') {
              fetchQueryRows(queryId, 0, 10_000)
                .then((page) => {
                  setExplainText(page.rows.map((r) => String(r[0] ?? '')).join('\n'));
                  setExplainRunning(false);
                })
                .catch(() => setExplainRunning(false));
            } else if (event.type === 'error') {
              setExplainText(`-- ${event.error.message}`);
              setExplainRunning(false);
            }
          },
        });
      })
      .catch((err: unknown) => {
        setExplainText(`-- ${err instanceof Error ? err.message : 'EXPLAIN failed'}`);
        setExplainRunning(false);
      });
  }, [source, caretOffset, context.catalog, context.schema]);

  return (
    <div>
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
        onToggleAutoLimit={() => setAutoLimit((v) => !v)}
        onLimitChange={setLimit}
        onMoveUp={chrome.onMoveUp}
        onMoveDown={chrome.onMoveDown}
        onDelete={chrome.onDelete}
        dragHandleProps={chrome.dragHandleProps}
      />
      {!collapsed && (
        <>
          <div className="bg-surface-raised">
            <SqlEditor
              value={source}
              onChange={handleChange}
              onExecute={handleExecute}
              onReady={handleReady}
              ariaLabel={`SQL cell ${name ?? ''}`}
            />
          </div>
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
            // (design.md §4 resultMeta: 再ロード時に「前回実行」を表示).
            resultMeta && <LastRunStrip meta={resultMeta} onRun={runWholeCell} />
          )}
        </>
      )}
    </div>
  );
}
