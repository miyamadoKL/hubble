/**
 * AiPanel.tsx
 *
 * 画面右側に表示する AI アシスタントパネル。SQL assistant MVP の 4 タスク
 * （選択 SQL の説明、エラー修正案、SQL 下書き、書き換え）の入口となる。
 *
 * 設計方針:
 * - 対象 SQL は「最後にフォーカスされていた SQL セル」（activeEditor レジストリ）から
 *   取得する。選択範囲があれば選択部分、なければセル全文を使う。
 * - AI はエディターを直接書き換えない。提案 SQL は AiDiffApply の diff 確認を経て、
 *   ユーザーの Apply 操作で初めて `executeEdits`（undo 可能）により反映される。
 * - スキーマ文脈はユーザーが明示したテーブル名（FQN）を既存メタデータ API で解決して
 *   渡す。結果行データは一切送らない（Phase 1 の安全条件）。
 */
import { useEffect, useRef, useState } from 'react';
import type * as monaco from 'monaco-editor';
import { Loader2, Sparkles, Square, Wand2, Wrench, PenLine, BookOpen, X } from 'lucide-react';
import type { AiAssistRequest, AiTableContext, AiTask } from '@hubble/contracts';
import { streamAiAssist } from '../../api/ai';
import { ApiClientError } from '../../api/client';
import { fetchTableDetail } from '../../api/metadata';
import { getActiveEditor } from '../../editor/activeEditor';
import { useExecutionStore } from '../../execution';
import { useConfig } from '../../hooks/useConfig';
import { AI_PANEL_MAX_WIDTH, AI_PANEL_MIN_WIDTH, useUiStore } from '../../stores/uiStore';
import { Button } from '../common/Button';
import { IconButton } from '../common/IconButton';
import { toast } from '../common/Toast';
import { Markdown } from '../notebook/Markdown';
import { AiDiffApply } from '../editor/AiDiffApply';

/** 適用先として記憶しておく、リクエスト時点のエディターと対象範囲。 */
export interface CapturedTarget {
  cellId: string;
  editor: monaco.editor.IStandaloneCodeEditor;
  /** 対象範囲（選択範囲、またはセル全文）。 */
  range: monaco.IRange;
  /** 対象範囲のリクエスト時点のテキスト（diff の左側に使う）。 */
  original: string;
  /** リクエスト時点のmodel識別子。 */
  modelUri: string;
  /** 編集に追随する対象範囲のdecoration。 */
  tracking: monaco.editor.IEditorDecorationsCollection;
}

type TargetSnapshot = Omit<CapturedTarget, 'tracking'>;

/** AI提案をキャプチャ時点と同じ対象へ適用する。 */
export function applyCapturedSql(target: CapturedTarget, sql: string): boolean {
  const model = target.editor.getModel();
  const trackedRange = target.tracking.getRange(0);
  if (
    !model ||
    model.uri.toString() !== target.modelUri ||
    !trackedRange ||
    model.getValueInRange(trackedRange) !== target.original
  ) {
    return false;
  }
  const startOffset = model.getOffsetAt({
    lineNumber: trackedRange.startLineNumber,
    column: trackedRange.startColumn,
  });
  target.editor.executeEdits('ai-assistant-apply', [
    { range: trackedRange, text: sql, forceMoveMarkers: true },
  ]);
  const end = model.getPositionAt(startOffset + sql.length);
  target.tracking.set([
    {
      range: {
        startLineNumber: trackedRange.startLineNumber,
        startColumn: trackedRange.startColumn,
        endLineNumber: end.lineNumber,
        endColumn: end.column,
      },
      options: {},
    },
  ]);
  target.editor.focus();
  return true;
}

/** タスクボタンの表示定義。 */
const TASKS: { task: AiTask; label: string; icon: typeof Sparkles; hint: string }[] = [
  { task: 'explain', label: 'Explain', icon: BookOpen, hint: '選択 SQL（または全文）を説明する' },
  { task: 'fix', label: 'Fix error', icon: Wrench, hint: '直近のエラーから修正案を出す' },
  { task: 'draft', label: 'Draft', icon: PenLine, hint: '指示とテーブル情報から SQL を下書きする' },
  { task: 'rewrite', label: 'Rewrite', icon: Wand2, hint: '指示に沿って SQL を書き換える' },
];

/**
 * `catalog.schema.table` または `schema.table` のカンマ区切り入力をパースする。
 * 2 要素の場合は現在の shell コンテキストの catalog を補う。
 */
function parseTableNames(
  input: string,
  contextCatalog: string | undefined,
): { catalog: string; schema: string; table: string }[] {
  return input
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((name) => {
      const parts = name.split('.').map((p) => p.trim());
      const [a, b, c] = parts;
      if (parts.length === 3 && a && b && c) return { catalog: a, schema: b, table: c };
      if (parts.length === 2 && a && b && contextCatalog) {
        return { catalog: contextCatalog, schema: a, table: b };
      }
      throw new Error(`Invalid table name: ${name} (expected catalog.schema.table)`);
    });
}

/**
 * AI アシスタントパネル本体。開閉と幅は uiStore が持ち、AppShell から
 * メインエリアの右側に配置される。
 */
export function AiPanel() {
  const { data: config } = useConfig();
  const width = useUiStore((s) => s.aiPanelWidth);
  const setWidth = useUiStore((s) => s.setAiPanelWidth);
  const toggle = useUiStore((s) => s.toggleAiPanel);
  const shellContext = useUiStore((s) => s.shellContext);

  // 指示テキスト（draft では必須、rewrite では任意）。
  const [instruction, setInstruction] = useState('');
  // 文脈として渡すテーブル名（カンマ区切り FQN）。
  const [tablesInput, setTablesInput] = useState('');
  // ストリーミング中かどうか。
  const [streaming, setStreaming] = useState(false);
  // 蓄積された応答テキスト。
  const [text, setText] = useState('');
  // 実行したタスク（応答表示のラベルに使う）。
  const [lastTask, setLastTask] = useState<AiTask | null>(null);
  // 抽出された提案 SQL（fix / draft / rewrite の応答に ```sql block がある場合）。
  const [proposedSql, setProposedSql] = useState<string | null>(null);
  // diff 確認モーダルの開閉。
  const [diffOpen, setDiffOpen] = useState(false);
  // リクエスト時点の適用先（エディターと対象範囲）。diff モーダルの表示にも使うため state で持つ。
  const [target, setTarget] = useState<CapturedTarget | null>(null);
  const targetRef = useRef<CapturedTarget | null>(null);
  // 実行中リクエストの中断用。
  const abortRef = useRef<AbortController | null>(null);
  // パネル幅リサイズのドラッグ状態。
  const draggingRef = useRef(false);

  useEffect(
    () => () => {
      targetRef.current?.tracking.clear();
      targetRef.current = null;
    },
    [],
  );

  /** アクティブエディターから装飾を作らず対象を読み取る。 */
  const inspectTarget = (): TargetSnapshot | null => {
    const reg = getActiveEditor();
    const model = reg?.editor.getModel();
    if (!reg || !model) return null;
    const selection = reg.editor.getSelection();
    // 選択範囲が空でなければ選択部分、空ならセル全文を対象にする。
    if (selection && !selection.isEmpty()) {
      return {
        cellId: reg.cellId,
        editor: reg.editor,
        range: selection,
        original: model.getValueInRange(selection),
        modelUri: model.uri.toString(),
      };
    }
    const range = model.getFullModelRange();
    return {
      cellId: reg.cellId,
      editor: reg.editor,
      range,
      original: model.getValue(),
      modelUri: model.uri.toString(),
    };
  };

  /** 検証済み対象へ編集追随用のdecorationを追加する。 */
  const trackTarget = (snapshot: TargetSnapshot): CapturedTarget => ({
    ...snapshot,
    tracking: snapshot.editor.createDecorationsCollection([{ range: snapshot.range, options: {} }]),
  });

  /** 以前のdecorationを破棄して適用対象を置き換える。 */
  const replaceTarget = (next: CapturedTarget | null): void => {
    targetRef.current?.tracking.clear();
    targetRef.current = next;
    setTarget(next);
  };

  /** 指定タスクのリクエストを組み立てて送信する。 */
  const run = async (task: AiTask) => {
    if (streaming) return;
    const inspected = inspectTarget();

    // タスク別の入力検証。契約の superRefine と同じ条件を UI 側でも先に確認する。
    if (
      (task === 'explain' || task === 'fix' || task === 'rewrite') &&
      !inspected?.original.trim()
    ) {
      toast.error('AI assistant', 'Focus a SQL cell with content first.');
      return;
    }
    let errorMessage: string | undefined;
    if (task === 'fix') {
      const cellError = inspected
        ? useExecutionStore.getState().cells[inspected.cellId]?.error
        : undefined;
      if (!cellError) {
        toast.error('AI assistant', 'The focused cell has no recent error to fix.');
        return;
      }
      errorMessage = cellError.message;
    }
    if (task === 'draft' && instruction.trim() === '') {
      toast.error('AI assistant', 'Write an instruction for the draft first.');
      return;
    }

    // テーブル文脈の解決（明示された FQN のみ。失敗したら中断してユーザーに知らせる）。
    let tableNames: { catalog: string; schema: string; table: string }[] | undefined;
    if (tablesInput.trim() !== '') {
      const datasourceId = shellContext.datasourceId;
      if (!datasourceId) {
        toast.error('AI assistant', 'No datasource selected.');
        return;
      }
      try {
        tableNames = parseTableNames(tablesInput, shellContext.catalog);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        toast.error('AI assistant', `Failed to resolve context tables: ${message}`);
        return;
      }
    }

    const captured = inspected ? trackTarget(inspected) : null;
    let tables: AiTableContext[] | undefined;
    if (tableNames) {
      const datasourceId = shellContext.datasourceId!;
      try {
        const details = await Promise.all(
          tableNames.map((n) => fetchTableDetail(datasourceId, n.catalog, n.schema, n.table)),
        );
        tables = details.map((d) => ({
          catalog: d.catalog,
          schema: d.schema,
          table: d.name,
          columns: d.columns.map((c) => ({ name: c.name, type: c.type })),
        }));
      } catch (err) {
        captured?.tracking.clear();
        const message = err instanceof Error ? err.message : String(err);
        toast.error('AI assistant', `Failed to resolve context tables: ${message}`);
        return;
      }
    }

    const request: AiAssistRequest = {
      task,
      ...(shellContext.datasourceId ? { datasourceId: shellContext.datasourceId } : {}),
      ...(captured && task !== 'draft' ? { sql: captured.original } : {}),
      ...(errorMessage !== undefined ? { errorMessage } : {}),
      ...(instruction.trim() !== '' ? { instruction: instruction.trim() } : {}),
      ...(tables !== undefined ? { tables } : {}),
      context: {
        ...(shellContext.catalog ? { catalog: shellContext.catalog } : {}),
        ...(shellContext.schema ? { schema: shellContext.schema } : {}),
      },
    };

    // 適用先はリクエスト時点のエディターと範囲で固定する（応答中のフォーカス移動に影響されない）。
    replaceTarget(captured);
    setLastTask(task);
    setText('');
    setProposedSql(null);
    setStreaming(true);
    const abort = new AbortController();
    abortRef.current = abort;
    let proposalReceived = false;
    try {
      await streamAiAssist(
        request,
        {
          onEvent: (event) => {
            if (event.type === 'delta') setText((cur) => cur + event.text);
            if (event.type === 'done') {
              setText(event.text);
              if (event.sql) {
                proposalReceived = true;
                setProposedSql(event.sql);
              }
            }
            if (event.type === 'error') {
              toast.error('AI assistant', event.error.message);
            }
          },
        },
        { signal: abort.signal },
      );
    } catch (err) {
      if (abort.signal.aborted) {
        // ユーザーによる停止は正常系として扱う。
      } else if (err instanceof ApiClientError) {
        toast.error('AI assistant', err.detail.message);
      } else {
        toast.error('AI assistant', err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (!proposalReceived && targetRef.current === captured) replaceTarget(null);
      setStreaming(false);
      abortRef.current = null;
    }
  };

  /** 提案 SQL をリクエスト時点の対象範囲に適用する（undo 可能な executeEdits 経由）。 */
  const applySql = (sql: string) => {
    setDiffOpen(false);
    if (target && applyCapturedSql(target, sql)) {
      toast.success('AI assistant', 'Proposed SQL applied. Undo with Ctrl/Cmd+Z.');
      return;
    }
    toast.error('AI assistant', 'The target changed while waiting. Copy the SQL manually.');
  };

  // 左端ドラッグでの幅リサイズ（Sidebar と同じ pointer イベント方式）。
  const startDrag = (e: React.PointerEvent) => {
    draggingRef.current = true;
    const startX = e.clientX;
    const startWidth = width;
    const onMove = (ev: PointerEvent) => {
      if (!draggingRef.current) return;
      setWidth(startWidth + (startX - ev.clientX));
    };
    const onUp = () => {
      draggingRef.current = false;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.removeProperty('cursor');
      document.body.style.removeProperty('user-select');
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  return (
    <aside
      className="relative flex h-full shrink-0 flex-col border-l border-border-base bg-surface-base"
      style={{ width: `${width}px` }}
      aria-label="AI assistant panel"
    >
      {/* Resize handle（パネル左端）。 */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize AI panel"
        aria-valuenow={width}
        aria-valuemin={AI_PANEL_MIN_WIDTH}
        aria-valuemax={AI_PANEL_MAX_WIDTH}
        tabIndex={0}
        onPointerDown={startDrag}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') setWidth(width + 16);
          else if (e.key === 'ArrowRight') setWidth(width - 16);
        }}
        className="group absolute top-0 -left-1 z-10 h-full w-2 cursor-col-resize"
      >
        <span className="absolute top-0 left-1 h-full w-px bg-transparent transition-colors group-hover:bg-accent group-focus-visible:bg-accent" />
      </div>

      {/* ヘッダー: タイトル、モデル表示、閉じるボタン。 */}
      <div className="flex items-center justify-between px-3 pt-3 pb-2">
        <h2 className="flex items-center gap-1.5 text-2xs font-semibold tracking-[0.14em] text-ink-muted uppercase">
          <Sparkles size={13} strokeWidth={1.75} className="text-accent" />
          AI assistant
        </h2>
        <div className="flex items-center gap-1">
          {config?.ai.model && (
            <span className="rounded-sm bg-surface-sunken px-1.5 py-0.5 font-mono text-2xs text-ink-subtle">
              {config.ai.model}
            </span>
          )}
          <IconButton icon={X} label="Close AI panel" size="sm" onClick={toggle} />
        </div>
      </div>

      {/* タスクボタン列。 */}
      <div className="grid grid-cols-2 gap-1.5 px-3 pb-2">
        {TASKS.map(({ task, label, icon: Icon, hint }) => (
          <button
            key={task}
            type="button"
            title={hint}
            disabled={streaming}
            onClick={() => void run(task)}
            className="flex items-center gap-1.5 rounded-md border border-border-base px-2 py-1.5 text-xs text-ink-base transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Icon size={14} strokeWidth={1.75} />
            {label}
          </button>
        ))}
      </div>

      {/* 指示とテーブル文脈の入力欄。 */}
      <div className="flex flex-col gap-2 px-3 pb-2">
        <textarea
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="Instruction (required for Draft, optional for Rewrite)…"
          rows={2}
          className="w-full resize-y rounded-md border border-border-base bg-surface-raised px-2 py-1.5 text-xs text-ink-base placeholder:text-ink-subtle focus:border-accent focus:outline-none"
        />
        <input
          value={tablesInput}
          onChange={(e) => setTablesInput(e.target.value)}
          placeholder="Context tables: catalog.schema.table, …"
          className="w-full rounded-md border border-border-base bg-surface-raised px-2 py-1.5 font-mono text-xs text-ink-base placeholder:text-ink-subtle focus:border-accent focus:outline-none"
        />
      </div>

      {/* 応答表示エリア。 */}
      <div className="min-h-0 flex-1 overflow-auto border-t border-border-subtle px-3 py-2">
        {text === '' && !streaming && (
          <p className="text-xs leading-relaxed text-ink-subtle">
            Focus a SQL cell, then pick a task. The assistant only proposes SQL; execution always
            goes through the normal editor flow.
          </p>
        )}
        {streaming && text === '' && (
          <p className="flex items-center gap-1.5 text-xs text-ink-muted">
            <Loader2 size={13} className="animate-spin" /> Waiting for the model…
          </p>
        )}
        {text !== '' && (
          <div data-testid="ai-response">
            {lastTask && (
              <p className="mb-1 text-2xs font-semibold tracking-[0.14em] text-ink-subtle uppercase">
                {lastTask}
              </p>
            )}
            <Markdown source={text} className="text-xs" />
          </div>
        )}
      </div>

      {/* フッター: 停止 / 提案 SQL の確認。 */}
      <div className="flex items-center justify-end gap-2 border-t border-border-subtle px-3 py-2">
        {streaming && (
          <Button variant="ghost" size="sm" icon={Square} onClick={() => abortRef.current?.abort()}>
            Stop
          </Button>
        )}
        {proposedSql !== null && !streaming && (
          <Button variant="primary" size="sm" icon={Wand2} onClick={() => setDiffOpen(true)}>
            Review &amp; apply
          </Button>
        )}
      </div>

      {/* 提案 SQL の diff 確認モーダル。 */}
      <AiDiffApply
        open={diffOpen}
        original={target?.original ?? ''}
        proposed={proposedSql ?? ''}
        onApply={applySql}
        onClose={() => setDiffOpen(false)}
      />
    </aside>
  );
}
