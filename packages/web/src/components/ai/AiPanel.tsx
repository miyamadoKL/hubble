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
import { useT, type TFn } from '../../i18n/t';
import { aiMessages } from '../../i18n/messages/ai';

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

/** 単一 AI request が所有する世代と中断 controller。 */
export interface AiRequestClaim {
  generation: number;
  controller: AbortController;
}

/** AI request の排他所有権と世代判定を同期的に管理する。 */
export class AiRequestCoordinator {
  private generation = 0;
  private active: AiRequestClaim | null = null;
  private readonly controllers = new Set<AbortController>();

  /** 実行中 request がなければ次の世代を取得する。 */
  claim(): AiRequestClaim | null {
    if (this.active !== null) return null;
    const claim = {
      generation: ++this.generation,
      controller: new AbortController(),
    };
    this.active = claim;
    this.controllers.add(claim.controller);
    return claim;
  }

  /** callback が現在の request に属するかを確認する。 */
  isCurrent(claim: AiRequestClaim): boolean {
    return this.active === claim;
  }

  /** 現在の request を完了し、次の世代を取得可能にする。 */
  finish(claim: AiRequestClaim): boolean {
    if (!this.isCurrent(claim)) return false;
    this.controllers.delete(claim.controller);
    this.active = null;
    return true;
  }

  /** 現在の request を中断し、その世代を同期的に無効化する。 */
  abortCurrent(): boolean {
    const claim = this.active;
    if (claim === null) return false;
    claim.controller.abort();
    this.controllers.delete(claim.controller);
    this.active = null;
    this.generation += 1;
    return true;
  }

  /** 保持する全 controller を中断し、古い世代を無効化する。 */
  dispose(): void {
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.active = null;
    this.generation += 1;
  }
}

/** AI パネルの resize listener と body style を設定し、解除関数を返す。 */
export function beginPanelResize(
  startX: number,
  startWidth: number,
  setWidth: (width: number) => void,
  onEnd: () => void = () => {},
): () => void {
  const previousCursor = document.body.style.cursor;
  const previousUserSelect = document.body.style.userSelect;
  let active = true;
  const onMove = (event: PointerEvent) => {
    if (active) setWidth(startWidth + (startX - event.clientX));
  };
  const cleanup = () => {
    if (!active) return;
    active = false;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', cleanup);
    document.body.style.cursor = previousCursor;
    document.body.style.userSelect = previousUserSelect;
    onEnd();
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', cleanup);
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  return cleanup;
}

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

// タスクラベル/ヒントの辞書キー（プレースホルダーを持たないキーのみに限定する）。
// keyof typeof aiMessages のような広い union にすると、t() の引数型がプレース
// ホルダーありのキーとの union になり呼び出し側で型エラーになるため、使用する
// キーだけの union で narrow している。
type TaskLabelKey = 'taskExplainLabel' | 'taskFixLabel' | 'taskDraftLabel' | 'taskRewriteLabel';
type TaskHintKey = 'taskExplainHint' | 'taskFixHint' | 'taskDraftHint' | 'taskRewriteHint';

/** タスクボタンの表示定義。ラベルとヒントは辞書キーで持ち、描画時に useT で引く。 */
const TASK_CONFIG: {
  task: AiTask;
  icon: typeof Sparkles;
  labelKey: TaskLabelKey;
  hintKey: TaskHintKey;
}[] = [
  { task: 'explain', icon: BookOpen, labelKey: 'taskExplainLabel', hintKey: 'taskExplainHint' },
  { task: 'fix', icon: Wrench, labelKey: 'taskFixLabel', hintKey: 'taskFixHint' },
  { task: 'draft', icon: PenLine, labelKey: 'taskDraftLabel', hintKey: 'taskDraftHint' },
  { task: 'rewrite', icon: Wand2, labelKey: 'taskRewriteLabel', hintKey: 'taskRewriteHint' },
];

/**
 * `AiTask`（契約値: explain/fix/draft/rewrite）から表示ラベルの辞書キーを求める。
 * レビュー指摘: 応答エリアの直前タスク表示（`lastTask`）が契約値をそのまま
 * 生表示していたため、`TASK_CONFIG` と同じマッピングを単体テスト可能な純粋関数
 * として切り出した。
 */
export function taskLabelKey(task: AiTask): TaskLabelKey {
  return TASK_CONFIG.find((c) => c.task === task)!.labelKey;
}

/**
 * `catalog.schema.table` または `schema.table` のカンマ区切り入力をパースする。
 * 2 要素の場合は現在の shell コンテキストの catalog を補う。
 *
 * @param input カンマ区切りのテーブル名入力。
 * @param contextCatalog 2 要素表記を補完するための現在の catalog（未指定なら補完しない）。
 * @param t エラーメッセージの翻訳に使う関数（AiPanel の useT(aiMessages) を渡す）。
 */
function parseTableNames(
  input: string,
  contextCatalog: string | undefined,
  t: TFn<typeof aiMessages>,
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
      throw new Error(t('invalidTableName', { name }));
    });
}

/**
 * AI アシスタントパネル本体。開閉と幅は uiStore が持ち、AppShell から
 * メインエリアの右側に配置される。
 */
export function AiPanel() {
  const t = useT(aiMessages);
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
  // request の排他所有権と世代も同期的に管理する。
  const requestCoordinatorRef = useRef(new AiRequestCoordinator());
  // パネル幅リサイズのドラッグ状態。
  // resize の listener と body style を戻す関数で保持する。
  const dragCleanupRef = useRef<(() => void) | null>(null);

  useEffect(
    () => () => {
      requestCoordinatorRef.current.dispose();
      targetRef.current?.tracking.clear();
      targetRef.current = null;
      dragCleanupRef.current?.();
      dragCleanupRef.current = null;
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
    const inspected = inspectTarget();

    // タスク別の入力検証。契約の superRefine と同じ条件を UI 側でも先に確認する。
    if (
      (task === 'explain' || task === 'fix' || task === 'rewrite') &&
      !inspected?.original.trim()
    ) {
      toast.error(t('toastTitle'), t('toastFocusSqlCell'));
      return;
    }
    let errorMessage: string | undefined;
    if (task === 'fix') {
      const cellError = inspected
        ? useExecutionStore.getState().cells[inspected.cellId]?.error
        : undefined;
      if (!cellError) {
        toast.error(t('toastTitle'), t('toastNoRecentError'));
        return;
      }
      errorMessage = cellError.message;
    }
    if (task === 'draft' && instruction.trim() === '') {
      toast.error(t('toastTitle'), t('toastWriteInstruction'));
      return;
    }

    // テーブル文脈の解決（明示された FQN のみ。失敗したら中断してユーザーに知らせる）。
    let tableNames: { catalog: string; schema: string; table: string }[] | undefined;
    if (tablesInput.trim() !== '') {
      const datasourceId = shellContext.datasourceId;
      if (!datasourceId) {
        toast.error(t('toastTitle'), t('toastNoDatasource'));
        return;
      }
      try {
        tableNames = parseTableNames(tablesInput, shellContext.catalog, t);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        toast.error(t('toastTitle'), t('toastFailedResolveTables', { message }));
        return;
      }
    }

    // React state の反映より先に排他的な世代を取得し、metadata 待機中の二重起動を防ぐ。
    const requestCoordinator = requestCoordinatorRef.current;
    const claim = requestCoordinator.claim();
    if (claim === null) return;
    setStreaming(true);

    let captured: CapturedTarget | null = null;
    let tables: AiTableContext[] | undefined;
    let proposalReceived = false;
    let resolvingTables = false;
    try {
      // 適用先はリクエスト時点のエディターと範囲で固定する（応答中のフォーカス移動に影響されない）。
      captured = inspected ? trackTarget(inspected) : null;
      // request 開始時に表示と適用先を同じ世代へ切り替える。
      replaceTarget(captured);
      setLastTask(task);
      setText('');
      setProposedSql(null);
      if (tableNames) {
        const datasourceId = shellContext.datasourceId!;
        resolvingTables = true;
        const details = await Promise.all(
          tableNames.map((n) =>
            fetchTableDetail(datasourceId, n.catalog, n.schema, n.table, claim.controller.signal),
          ),
        );
        resolvingTables = false;
        if (!requestCoordinator.isCurrent(claim)) return;
        tables = details.map((d) => ({
          catalog: d.catalog,
          schema: d.schema,
          table: d.name,
          columns: d.columns.map((c) => ({ name: c.name, type: c.type })),
        }));
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

      await streamAiAssist(
        request,
        {
          onEvent: (event) => {
            if (!requestCoordinator.isCurrent(claim)) return;
            if (event.type === 'delta') setText((cur) => cur + event.text);
            if (event.type === 'done') {
              setText(event.text);
              if (event.sql) {
                proposalReceived = true;
                setProposedSql(event.sql);
              }
            }
            if (event.type === 'error') {
              toast.error(t('toastTitle'), event.error.message);
            }
          },
        },
        { signal: claim.controller.signal },
      );
    } catch (err) {
      if (!requestCoordinator.isCurrent(claim)) {
        // unmount 後または古い世代の失敗は UI へ反映しない。
      } else if (claim.controller.signal.aborted) {
        // ユーザーによる停止は正常系として扱う。
      } else if (resolvingTables) {
        const message = err instanceof Error ? err.message : String(err);
        toast.error(t('toastTitle'), t('toastFailedResolveTables', { message }));
      } else if (err instanceof ApiClientError) {
        toast.error(t('toastTitle'), err.detail.message);
      } else {
        toast.error(t('toastTitle'), err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (!requestCoordinator.isCurrent(claim)) {
        captured?.tracking.clear();
      } else {
        if (!proposalReceived && targetRef.current === captured) replaceTarget(null);
        requestCoordinator.finish(claim);
        setStreaming(false);
      }
    }
  };

  /** 提案 SQL をリクエスト時点の対象範囲に適用する（undo 可能な executeEdits 経由）。 */
  const applySql = (sql: string) => {
    setDiffOpen(false);
    if (target && applyCapturedSql(target, sql)) {
      toast.success(t('toastTitle'), t('toastSqlApplied'));
      return;
    }
    toast.error(t('toastTitle'), t('toastTargetChanged'));
  };

  /** requestを中断し、世代と表示中の適用先を同期的に解放する。 */
  const stopRequest = () => {
    if (!requestCoordinatorRef.current.abortCurrent()) return;
    replaceTarget(null);
    setStreaming(false);
  };

  // 左端ドラッグでの幅リサイズ（Sidebar と同じ pointer イベント方式）。
  const startDrag = (e: React.PointerEvent) => {
    dragCleanupRef.current?.();
    const cleanup = beginPanelResize(e.clientX, width, setWidth, () => {
      if (dragCleanupRef.current === cleanup) dragCleanupRef.current = null;
    });
    dragCleanupRef.current = cleanup;
  };

  return (
    <aside
      className="relative flex h-full shrink-0 flex-col border-l border-border-base bg-surface-base"
      style={{ width: `${width}px` }}
      aria-label={t('panelAriaLabel')}
    >
      {/* Resize handle（パネル左端）。 */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('resizeHandleLabel')}
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
          {t('panelHeading')}
        </h2>
        <div className="flex items-center gap-1">
          {config?.ai.model && (
            <span className="rounded-sm bg-surface-sunken px-1.5 py-0.5 font-mono text-2xs text-ink-subtle">
              {config.ai.model}
            </span>
          )}
          <IconButton icon={X} label={t('closePanel')} size="sm" onClick={toggle} />
        </div>
      </div>

      {/* タスクボタン列。 */}
      <div className="grid grid-cols-2 gap-1.5 px-3 pb-2">
        {TASK_CONFIG.map(({ task, icon: Icon, labelKey, hintKey }) => (
          <button
            key={task}
            type="button"
            title={t(hintKey)}
            disabled={streaming}
            onClick={() => void run(task)}
            className="flex items-center gap-1.5 rounded-md border border-border-base px-2 py-1.5 text-xs text-ink-base transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Icon size={14} strokeWidth={1.75} />
            {t(labelKey)}
          </button>
        ))}
      </div>

      {/* 指示とテーブル文脈の入力欄。 */}
      <div className="flex flex-col gap-2 px-3 pb-2">
        <textarea
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder={t('instructionPlaceholder')}
          rows={2}
          className="w-full resize-y rounded-md border border-border-base bg-surface-raised px-2 py-1.5 text-xs text-ink-base placeholder:text-ink-subtle focus:border-accent focus:outline-none"
        />
        <input
          value={tablesInput}
          onChange={(e) => setTablesInput(e.target.value)}
          placeholder={t('tablesPlaceholder')}
          className="w-full rounded-md border border-border-base bg-surface-raised px-2 py-1.5 font-mono text-xs text-ink-base placeholder:text-ink-subtle focus:border-accent focus:outline-none"
        />
      </div>

      {/* 応答表示エリア。 */}
      <div className="min-h-0 flex-1 overflow-auto border-t border-border-subtle px-3 py-2">
        {text === '' && !streaming && (
          <p className="text-xs leading-relaxed text-ink-subtle">{t('emptyStateText')}</p>
        )}
        {streaming && text === '' && (
          <p className="flex items-center gap-1.5 text-xs text-ink-muted">
            <Loader2 size={13} className="animate-spin" /> {t('waitingForModel')}
          </p>
        )}
        {text !== '' && (
          <div data-testid="ai-response">
            {lastTask && (
              <p className="mb-1 text-2xs font-semibold tracking-[0.14em] text-ink-subtle uppercase">
                {/* lastTask は契約値 (explain/fix/draft/rewrite) なので、そのまま表示せず
                    taskLabelKey() 経由で翻訳済みラベルへ変換する。 */}
                {t(taskLabelKey(lastTask))}
              </p>
            )}
            <Markdown source={text} className="text-xs" />
          </div>
        )}
      </div>

      {/* フッター: 停止 / 提案 SQL の確認。 */}
      <div className="flex items-center justify-end gap-2 border-t border-border-subtle px-3 py-2">
        {streaming && (
          <Button variant="ghost" size="sm" icon={Square} onClick={stopRequest}>
            {t('stopButton')}
          </Button>
        )}
        {proposedSql !== null && !streaming && (
          <Button variant="primary" size="sm" icon={Wand2} onClick={() => setDiffOpen(true)}>
            {t('reviewAndApplyButton')}
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
