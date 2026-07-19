/**
 * NotebookView.tsx
 *
 * Notebook 編集画面のメインコンポーネント群。アクティブなノートブックのヘッダー
 * （名称と説明のインライン編集）、変数パネル、SQL/Markdown セルの一覧を描画し、
 * セルの追加、削除、並べ替え、折りたたみ、実行などすべての操作を zustand の
 * notebookStore / executionStore に橋渡しするオーケストレーター役のコンポーネント。
 * 画面上はタブで開いたノートブックのメインコンテンツ領域（中央カラム）に相当し、
 * 個々のセルの見た目や編集ロジック自体は SqlCell / MarkdownCell / CellToolbar に委譲する。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Cell } from '@hubble/contracts';
import { CellFrame, type CellStatus } from './CellFrame';
import { CellToolbar } from './CellToolbar';
import { CellInsert } from './CellInsert';
import { SqlCell, type SqlCellChrome } from './SqlCell';
import { MarkdownCell } from './MarkdownCell';
import { VariablePanel } from './VariablePanel';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { EmptyState } from '../common/EmptyState';
import { NotebookText, Share2 } from 'lucide-react';
import { toast } from '../common/Toast';
import { ShareModal } from '../common/ShareModal';
import { GitSyncControl } from '../github/GitSyncControl';
import { listNotebookShares, updateNotebookShares } from '../../api/notebooks';
import { isDocumentOwner } from '../../utils/documentShare';
import { cn } from '../../utils/cn';
import {
  NOTEBOOK_WIDTH_DEFAULT,
  NOTEBOOK_WIDTH_MIN,
  beginNotebookWidthResize,
  clampNotebookWidth,
  notebookWidthMax,
  readNotebookWidth,
  writeNotebookWidth,
} from '../../notebook/notebookWidth';
import {
  useCellExecution,
  executionActions,
  getCellBlock,
  isCellRunning,
  allUnits,
  type ExecutionContext,
  type ExecutionUnit,
} from '../../execution';
import { useActiveNotebook, useNotebookStore, substituteVariables } from '../../notebook';
import { useT, type TFn } from '../../i18n/t';
import { commonMessages } from '../../i18n/messages/common';
import { notebookMessages } from '../../i18n/messages/notebook';

/** NotebookView 内で使う辞書の合成。共通文言（Cancel 等）+ notebook 固有文言。 */
const notebookViewDict = { ...commonMessages, ...notebookMessages } as const;

/**
 * NotebookView: the active notebook's editable header, variable
 * panel, and cell list. All mutations flow through the notebook store; this
 * component is the orchestrator that wires cell toolbars, drag-reordering,
 * variable substitution and the delete-confirm modal.
 */

/**
 * NotebookView の props。
 * @property context - クエリ実行に使う既定のカタログ／スキーマ（アプリ全体の設定から供給される）。
 * @property defaultLimit - セルの LIMIT 自動付与に使う既定件数（/api/config 由来）。
 */
interface NotebookViewProps {
  context: { catalog: string; schema: string; datasourceId?: string };
  defaultLimit: number;
  costEstimateEnabled?: boolean;
  trinoLanguage?: boolean;
}

/**
 * セル左端のステータスガター（アイドル/実行中/成功/失敗）を、実行ストアに保持された
 * そのセルの実行レコードから導出するフック。
 */
/** Derive a cell's left-gutter status from its live execution record. */
function useCellStatus(cellId: string): CellStatus {
  const exec = useCellExecution(cellId);
  if (!exec) return 'idle'; // 実行レコードがまだない = 一度も実行していない
  if (isCellRunning(exec)) return 'running'; // 実行中（キャンセル待ちも含む）
  if (exec.state === 'finished') return 'finished';
  if (exec.state === 'failed') return 'failed';
  return 'idle';
}

/**
 * ノートブック編集画面のルートコンポーネント。アクティブなノートブックが無ければ
 * 空状態を表示し、あればヘッダー、変数パネル、セル一覧、削除確認モーダルを描画する。
 * @param context - 実行時に使うカタログ／スキーマのコンテキスト。
 * @param defaultLimit - 新規セル実行時の既定 LIMIT 値。
 */
export function NotebookView({
  context,
  defaultLimit,
  costEstimateEnabled = true,
  trinoLanguage = true,
}: NotebookViewProps) {
  const t = useT(notebookViewDict);
  const entry = useActiveNotebook();
  const store = useNotebookStore;

  // このコンポーネントが保持するローカル UI 状態。
  // pendingDelete: 削除確認モーダルの対象セル（null なら非表示）。
  // editingMarkdownId: 現在編集モード中の Markdown セル ID（同時に編集できるのは1つ）。
  // activeCellId: 直近でフォーカスされたセル（変数パネルの Ctrl/Cmd+Enter が対象にする）。
  // dragIndex / dragOverIndex: ネイティブ D&D によるセル並べ替えの進行状態
  //   （dragIndex は再レンダーを伴わない ref、dragOverIndex はホバー表示用の state）。
  const [pendingDelete, setPendingDelete] = useState<Cell | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [editingMarkdownId, setEditingMarkdownId] = useState<string | null>(null);
  const [activeCellId, setActiveCellId] = useState<string | null>(null);
  const dragIndex = useRef<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  // ノートブック列幅（全ノートブック共通のUI設定、localStorageに永続化）。
  // 初期値は localStorage の保存値をマウント時点のビューポート幅でクランプして読み込む
  // （他タブとの同期は不要な仕様のため、以降はここでの再読み込みを行わない）。
  const [notebookWidth, setNotebookWidthState] = useState(() =>
    clampNotebookWidth(
      readNotebookWidth(),
      typeof window !== 'undefined' ? window.innerWidth : NOTEBOOK_WIDTH_DEFAULT,
    ),
  );
  // 幅を変更し、クランプしたうえで localStorage へ保存する。
  const setNotebookWidth = (width: number) => {
    const clamped = clampNotebookWidth(
      width,
      typeof window !== 'undefined' ? window.innerWidth : NOTEBOOK_WIDTH_DEFAULT,
    );
    setNotebookWidthState(clamped);
    writeNotebookWidth(clamped);
  };
  // ハンドルのダブルクリックで既定幅へ戻す。
  const resetNotebookWidth = () => setNotebookWidth(NOTEBOOK_WIDTH_DEFAULT);

  // アクティブなノートブックが存在しない（何も開いていない）場合は空状態のみ表示する。
  if (!entry) {
    return (
      <NotebookWidthFrame
        width={notebookWidth}
        setWidth={setNotebookWidth}
        resetWidth={resetNotebookWidth}
        padding="px-6 py-16"
      >
        <EmptyState
          icon={NotebookText}
          title={t('noNotebookOpenTitle')}
          description={t('noNotebookOpenDesc')}
        />
      </NotebookWidthFrame>
    );
  }

  const notebook = entry.notebook;
  const notebookId = notebook.id;
  const readOnly =
    !entry.draft && notebook.myPermission !== 'owner' && notebook.myPermission !== 'edit';
  const canShare = !entry.draft && isDocumentOwner(notebook.myPermission);
  const cellContext: ExecutionContext = { ...context, notebookId };

  // Build the variable value map for substitution.
  // ノートブックの変数一覧を「変数名 → 値」のマップに変換する（${name} 置換で使用）。
  const variableValues: Record<string, string> = {};
  for (const v of notebook.variables) variableValues[v.name] = v.value;

  /**
   * ユニット実行（runUnit/runUnits）直前に変数を解決する。未定義の変数があれば
   * エラートーストを出して実行を中断させる（null を返して呼び出し元に中断を伝える）。
   */
  /** Substitute notebook variables into a unit before it runs. */
  const resolveUnit = (unit: ExecutionUnit): ExecutionUnit | null => {
    const { text, missing } = substituteVariables(unit.text, variableValues);
    if (missing.length > 0) {
      toast.error(
        t('missingVariableToastTitle'),
        t('missingVariableToastBody', {
          vars: missing.map((m) => `\${${m}}`).join(', '),
        }),
      );
      return null;
    }
    return { ...unit, text };
  };

  // 新規セルを追加する。Markdown セルは追加直後に編集モードへ入る（SQL セルはすぐ入力可能なため不要）。
  const handleAdd = (
    kind: 'sql' | 'markdown',
    position: 'end' | { relativeTo: string; where: 'above' | 'below' },
  ) => {
    const id = store.getState().addCell(notebookId, kind, position);
    if (kind === 'markdown') setEditingMarkdownId(id);
  };

  const confirmDelete = (cell: Cell) => {
    // Only prompt when the cell has content (内容ありは確認).
    // 空セルは確認なしで即削除し、内容があるセルだけ確認モーダルを挟んで誤操作を防ぐ。
    if (cell.source.trim() === '') {
      doDelete(cell.id);
    } else {
      setPendingDelete(cell);
    }
  };

  const doDelete = (cellId: string) => {
    executionActions().clear(cellId); // P3b handoff: free the execution record
    // 実行レコードを解放してからストアのセルを削除し、削除確認モーダルと
    // Markdown 編集状態が対象セルを指していればそれも解除する。
    store.getState().removeCell(notebookId, cellId);
    setPendingDelete(null);
    if (editingMarkdownId === cellId) setEditingMarkdownId(null);
  };

  /**
   * アクティブセルを実行する（変数パネルの Ctrl/Cmd+Enter から呼ばれる）。
   * フォーカス中の SQL セルがあればそれを対象にし、なければ最初の SQL セルにフォールバックする。
   */
  /** Run the active cell (used by the variable panel's Ctrl/Cmd+Enter). */
  const runActiveCell = () => {
    const nb = store.getState().open[notebookId]?.notebook;
    if (!nb) return;
    // activeCellId が現存するセルを指していればそれを、そうでなければ最初の SQL セルを使う。
    const targetId =
      activeCellId && nb.cells.some((c) => c.id === activeCellId)
        ? activeCellId
        : nb.cells.find((c) => c.kind === 'sql')?.id;
    if (!targetId) return;
    const cell = nb.cells.find((c) => c.id === targetId);
    if (!cell || cell.kind !== 'sql') return; // SQL セル以外（Markdown）は実行対象にしない
    runCellById(cell, cellContext, defaultLimit, variableValues, t);
  };

  // ---- Drag and drop (native, on the grip handle) ----
  // ネイティブ HTML5 D&D を利用したセル並べ替え。ドラッグ中のセル index は
  // dragIndex（ref、再レンダー不要）に保持し、ドロップ先の index が確定したら
  // notebookStore.moveCell で並べ替えを確定する。
  const onDrop = (toIndex: number) => {
    const from = dragIndex.current;
    setDragOverIndex(null);
    dragIndex.current = null;
    if (from === null || from === toIndex) return; // 同じ位置へのドロップは何もしない
    store.getState().moveCell(notebookId, from, toIndex);
  };

  const cells = notebook.cells;

  return (
    <NotebookWidthFrame
      width={notebookWidth}
      setWidth={setNotebookWidth}
      resetWidth={resetNotebookWidth}
      padding="px-6 py-6"
    >
      {/* ノートブック名と説明をインライン編集できるヘッダー */}
      <NotebookHeader
        name={notebook.name}
        description={notebook.description}
        readOnly={readOnly}
        canShare={canShare}
        onShare={() => setShareOpen(true)}
        onRename={(name) => store.getState().renameNotebook(notebookId, name)}
        onDescribe={(d) => store.getState().setDescription(notebookId, d)}
        gitControl={
          // 未保存ドラフトには出さない (サーバー保存後に push 可能になる)。
          <GitSyncControl
            type="notebook"
            id={entry.draft ? null : notebookId}
            documentName={notebook.name}
          />
        }
      />

      {/* 変数パネル：ノートブック変数の一覧編集と、Ctrl/Cmd+Enter によるアクティブセル実行 */}
      <VariablePanel
        variables={notebook.variables}
        onChange={(name, value) => store.getState().setVariableValue(notebookId, name, value)}
        onRunActive={runActiveCell}
      />

      <div className="flex flex-col">
        {/* セル一覧の先頭に表示する「セルを追加」挿入バー */}
        <CellInsert
          onAddSql={() =>
            handleAdd('sql', cells.length ? { relativeTo: cells[0]!.id, where: 'above' } : 'end')
          }
          onAddMarkdown={() =>
            handleAdd(
              'markdown',
              cells.length ? { relativeTo: cells[0]!.id, where: 'above' } : 'end',
            )
          }
        />
        {cells.map((cell, index) => (
          <div
            key={cell.id}
            data-testid="notebook-cell"
            onDragOver={(e) => {
              // ドラッグ操作中のみ、このセルの上にドロップ可能であることを示す。
              if (dragIndex.current === null) return;
              e.preventDefault();
              setDragOverIndex(index);
            }}
            onDrop={(e) => {
              e.preventDefault();
              onDrop(index);
            }}
            className={dragOverIndex === index ? 'rounded-lg ring-2 ring-accent/50' : undefined}
          >
            <ViewportCell
              cell={cell}
              initiallyVisible={index < 6}
              forceVisible={activeCellId === cell.id || editingMarkdownId === cell.id}
            >
              {/* セル本体：ステータス枠 + ツールバー + SQL エディタ／Markdown 本文 */}
              <CellRow
                cell={cell}
                context={cellContext}
                defaultLimit={defaultLimit}
                costEstimateEnabled={costEstimateEnabled}
                trinoLanguage={trinoLanguage}
                resolveUnit={resolveUnit}
                variableValues={variableValues}
                editingMarkdown={editingMarkdownId === cell.id}
                onStartEditMarkdown={() => setEditingMarkdownId(cell.id)}
                onCommitMarkdown={() => setEditingMarkdownId(null)}
                onFocus={() => setActiveCellId(cell.id)}
                onSourceChange={(src) => store.getState().setCellSource(notebookId, cell.id, src)}
                onRename={(name) => store.getState().setCellName(notebookId, cell.id, name)}
                onToggleCollapse={() => store.getState().toggleCellCollapsed(notebookId, cell.id)}
                onDelete={() => confirmDelete(cell)}
                onDragStart={() => {
                  dragIndex.current = index;
                }}
                onDragEnd={() => {
                  dragIndex.current = null;
                  setDragOverIndex(null);
                }}
              />
              {/* このセルの直後に新規セルを挿入するバー */}
              <CellInsert
                onAddSql={() => handleAdd('sql', { relativeTo: cell.id, where: 'below' })}
                onAddMarkdown={() => handleAdd('markdown', { relativeTo: cell.id, where: 'below' })}
              />
            </ViewportCell>
          </div>
        ))}
      </div>

      {/* セル削除の確認モーダル（内容があるセルを削除しようとしたときのみ表示） */}
      <Modal
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title={t('deleteCellModalTitle')}
        description={
          pendingDelete
            ? t('deleteCellModalDesc', { kind: pendingDelete.kind === 'sql' ? 'SQL' : 'Markdown' })
            : undefined
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              {t('cancel')}
            </Button>
            <Button variant="danger" onClick={() => pendingDelete && doDelete(pendingDelete.id)}>
              {t('deleteCellConfirmButton')}
            </Button>
          </>
        }
      >
        {pendingDelete?.source.trim() && (
          <pre className="max-h-40 overflow-auto rounded-md border border-border-subtle bg-surface-sunken px-3 py-2 font-mono text-xs text-ink-muted">
            {pendingDelete.source.slice(0, 400)}
          </pre>
        )}
      </Modal>
      {canShare && (
        <ShareModal
          open={shareOpen}
          onClose={() => setShareOpen(false)}
          documentName={notebook.name}
          fetchShares={() => listNotebookShares(notebookId)}
          updateShares={(shares) => updateNotebookShares(notebookId, shares)}
        />
      )}
    </NotebookWidthFrame>
  );
}

/**
 * ノートブック幅リサイズハンドル1本分。左右の端に重ねて配置し、ドラッグ、ダブルクリックでの
 * 既定幅リセット、フォーカス時の左右矢印キー（16px刻み）による調整に対応する。
 */
function NotebookWidthHandle({
  edge,
  width,
  max,
  onDragStart,
  onArrowResize,
  onReset,
}: {
  /** ハンドルが付いている辺。ドラッグ方向とキー操作の符号を決める。 */
  edge: 'left' | 'right';
  /** 現在の幅（aria-valuenow の表示に使う）。 */
  width: number;
  /** 現在のビューポート幅から求めた実際の上限（aria-valuemax の表示に使う）。 */
  max: number;
  /** pointerdown ハンドラー（ドラッグ開始）。 */
  onDragStart: (e: React.PointerEvent) => void;
  /** 矢印キーで幅を変更するハンドラー（クランプ前の絶対幅を渡す。クランプは呼び出し元が行う）。 */
  onArrowResize: (nextWidth: number) => void;
  /** ダブルクリックで既定幅へ戻すハンドラー。 */
  onReset: () => void;
}) {
  const t = useT(notebookViewDict);
  // 右ハンドルは ArrowRight で拡大、左ハンドルは ArrowLeft で拡大というように、
  // 辺ごとに矢印キーの意味が逆になる（どちらも「外側へ広げる」操作として揃える）。
  const sign = edge === 'right' ? 1 : -1;
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t('notebookWidthAria')}
      aria-valuenow={width}
      aria-valuemin={NOTEBOOK_WIDTH_MIN}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onDragStart}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        // ページ全体のスクロールと矢印キー操作が同時に発生しないよう、
        // このハンドルが処理する矢印キーは既定動作を必ず止める。
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          onArrowResize(width - sign * 16);
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          onArrowResize(width + sign * 16);
        }
      }}
      className={cn(
        'group absolute top-0 z-10 h-full w-3 cursor-col-resize touch-none',
        edge === 'left' ? '-left-3' : '-right-3',
      )}
    >
      <span
        className={cn(
          'absolute top-0 h-full w-px bg-transparent transition-colors group-hover:bg-accent group-focus-visible:bg-accent',
          edge === 'left' ? 'right-1' : 'left-1',
        )}
      />
    </div>
  );
}

/**
 * ノートブックの編集画面 / 空状態を中央寄せしつつ、左右端のドラッグハンドルで
 * 幅を変更できるようにするラッパー。幅そのものは呼び出し元（NotebookView）の
 * state で保持し、ここではハンドルの pointer/キーボード操作の配線と表示のみを担う。
 * テストのために export している（単体テストからハンドルの操作を検証する）。
 */
export function NotebookWidthFrame({
  width,
  setWidth,
  resetWidth,
  padding,
  children,
}: {
  /** 現在の幅（px）。 */
  width: number;
  /** 幅を変更する（クランプと永続化は呼び出し元が行う）。 */
  setWidth: (width: number) => void;
  /** 既定幅へリセットする。 */
  resetWidth: () => void;
  /** コンテナに適用する padding の Tailwind クラス（編集画面/空状態で異なる）。 */
  padding: string;
  children: ReactNode;
}) {
  // ドラッグ中の pointer リスナー解除関数。ドラッグ中でなければ null。
  const dragCleanupRef = useRef<(() => void) | null>(null);
  // unmount 時にドラッグ中のリスナーが残らないようにする。
  useEffect(() => () => dragCleanupRef.current?.(), []);

  // edge を引数に取る直接のトップレベル関数にしておく（curry で ref アクセスを含む
  // クロージャを render 中に生成する形にすると、react-hooks/refs lint ルールが
  // 「render 中の ref アクセス」として誤検知するため）。
  // ドラッグ開始時の pointerId を beginNotebookWidthResize に渡し、無関係な
  // ポインタ（マルチタッチ等）からの pointermove/pointerup/pointercancel を無視させる。
  const startDrag = (edge: 'left' | 'right', e: React.PointerEvent) => {
    dragCleanupRef.current?.();
    const cleanup = beginNotebookWidthResize(
      edge,
      e.clientX,
      width,
      setWidth,
      () => {
        if (dragCleanupRef.current === cleanup) dragCleanupRef.current = null;
      },
      e.pointerId,
    );
    dragCleanupRef.current = cleanup;
  };

  // aria-valuemax に表示する実際の上限（ビューポート幅依存）。
  const max = notebookWidthMax(typeof window !== 'undefined' ? window.innerWidth : width);

  return (
    <div className={cn('relative mx-auto w-full', padding)} style={{ maxWidth: `${width}px` }}>
      <NotebookWidthHandle
        edge="left"
        width={width}
        max={max}
        onDragStart={(e) => startDrag('left', e)}
        onArrowResize={setWidth}
        onReset={resetWidth}
      />
      {children}
      <NotebookWidthHandle
        edge="right"
        width={width}
        max={max}
        onDragStart={(e) => startDrag('right', e)}
        onArrowResize={setWidth}
        onReset={resetWidth}
      />
    </div>
  );
}

/** viewport 周辺だけ重いセル本体を mountし、領域外では高さを保った概要を表示する。 */
export function ViewportCell({
  cell,
  initiallyVisible,
  forceVisible,
  children,
}: {
  cell: Cell;
  initiallyVisible: boolean;
  forceVisible: boolean;
  children: ReactNode;
}) {
  const t = useT(notebookViewDict);
  const rootRef = useRef<HTMLDivElement>(null);
  const execution = useCellExecution(cell.id);
  const [visible, setVisible] = useState(
    () => initiallyVisible || typeof IntersectionObserver === 'undefined',
  );
  const [measuredHeight, setMeasuredHeight] = useState(160);

  useEffect(() => {
    const element = rootRef.current;
    if (!element || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        if (!entry.isIntersecting) {
          const height = element.getBoundingClientRect().height;
          if (height > 0) setMeasuredHeight(height);
        }
        setVisible(entry.isIntersecting);
      },
      { rootMargin: '800px 0px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const shouldRender =
    visible || forceVisible || (execution !== undefined && isCellRunning(execution));

  return (
    <div ref={rootRef} style={shouldRender ? undefined : { minHeight: measuredHeight }}>
      {shouldRender ? (
        children
      ) : (
        <div className="my-2 rounded-md border border-border bg-surface px-4 py-3 text-sm text-muted">
          <div className="font-medium text-foreground">
            {cell.name || t('cellKindFallback', { kind: cell.kind.toUpperCase() })}
          </div>
          <div className="mt-1 truncate font-mono">
            {cell.source.trim().split('\n')[0] || t('emptyCellFallback')}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * SQL セルの全ステートメントを、変数置換を適用しつつ命令的に実行するヘルパー。
 * Query Guard によりブロックされているセルは実行せずエラートーストのみ出す。
 * @param cell - 実行対象のセル（SQL セルでなければ何もしない）。
 * @param context - 実行時のカタログ／スキーマ／ノートブック ID。
 * @param defaultLimit - LIMIT 自動付与に使う既定件数。
 * @param values - 変数置換に使う「変数名 → 値」のマップ。
 */
/** Imperatively run all statements of a SQL cell with substitution applied. */
function runCellById(
  cell: Cell,
  context: ExecutionContext,
  defaultLimit: number,
  values: Record<string, string>,
  t: TFn<typeof notebookViewDict>,
): void {
  if (cell.kind !== 'sql') return;
  // Query Guard: refuse a blocked cell (variable panel's Ctrl/Cmd+Enter path).
  // Query Guard によりこのセルの直近見積もりがブロック判定なら、サーバへ送らず中断する。
  const block = getCellBlock(cell.id);
  if (block) {
    toast.error(
      t('blockedByQueryGuardToastTitle'),
      block.reasons[0] ?? t('exceedsScanLimitFallback'),
    );
    return;
  }
  const opts = { autoLimit: true, limit: defaultLimit };
  const resolved: ExecutionUnit[] = [];
  // セル内の各ステートメントに変数置換を適用する。1つでも未定義変数があれば全体を中断する。
  for (const u of allUnits(cell.source)) {
    const { text, missing } = substituteVariables(u.text, values);
    if (missing.length > 0) {
      toast.error(
        t('missingVariableToastTitle'),
        t('missingVariableToastBodyShort', {
          vars: missing.map((m) => `\${${m}}`).join(', '),
        }),
      );
      return;
    }
    resolved.push({ ...u, text });
  }
  if (resolved.length === 0) return;
  // ステートメントが1つなら単発実行、複数なら順次実行するバッチ API を使う。
  if (resolved.length === 1) executionActions().runUnit(cell.id, resolved[0]!, context, opts);
  else void executionActions().runUnits(cell.id, resolved, context, opts);
}

/**
 * ノートブックのタイトルと説明をインライン編集できるヘッダー。
 * クリックで編集モードに入り、blur または Enter で確定、Escape で取り消す。
 * @param name - 現在のノートブック名。
 * @param description - 現在のノートブック説明（空文字なら未設定）。
 * @param onRename - 名前確定時に呼ばれるコールバック。
 * @param onDescribe - 説明確定時に呼ばれるコールバック。
 */
export function NotebookHeader({
  name,
  description,
  readOnly,
  canShare,
  onShare,
  onRename,
  onDescribe,
  gitControl,
}: {
  name: string;
  description: string;
  readOnly: boolean;
  canShare: boolean;
  onShare: () => void;
  onRename: (name: string) => void;
  onDescribe: (description: string) => void;
  /** GitHub 同期コントロール (連携無効時は null を描画するコンポーネント)。 */
  gitControl?: ReactNode;
}) {
  const t = useT(notebookViewDict);
  // 名前と説明それぞれに「編集中か」フラグと編集中ドラフト値を持つ（互いに独立して編集できる）。
  const [editingName, setEditingName] = useState(false);
  const [editingDesc, setEditingDesc] = useState(false);
  const [nameDraft, setNameDraft] = useState(name);
  const [descDraft, setDescDraft] = useState(description);

  return (
    <header className="mb-4">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          {/* タイトル：read-only 時は編集不可、それ以外はクリックで編集開始 */}
          {readOnly || editingName ? (
            readOnly && !editingName ? (
              <h1 className="text-lg font-semibold text-ink-strong">{name}</h1>
            ) : (
              <input
                autoFocus
                value={nameDraft}
                aria-label={t('notebookNameLabel')}
                onChange={(e) => setNameDraft(e.target.value)}
                onBlur={() => {
                  setEditingName(false);
                  onRename(nameDraft);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  if (e.key === 'Escape') {
                    setNameDraft(name);
                    setEditingName(false);
                  }
                }}
                className="w-full bg-transparent text-lg font-semibold text-ink-strong focus:outline-none"
              />
            )
          ) : (
            <h1
              className="cursor-text text-lg font-semibold text-ink-strong"
              title={t('clickToRenameTitle')}
              onClick={() => {
                setNameDraft(name);
                setEditingName(true);
              }}
            >
              {name}
            </h1>
          )}

          {/* 説明：read-only 時は編集不可 */}
          {readOnly || editingDesc ? (
            readOnly && !editingDesc ? (
              description ? (
                <p className="mt-0.5 text-sm text-ink-muted">{description}</p>
              ) : null
            ) : (
              <input
                autoFocus
                value={descDraft}
                aria-label={t('notebookDescriptionAria')}
                onChange={(e) => setDescDraft(e.target.value)}
                onBlur={() => {
                  setEditingDesc(false);
                  onDescribe(descDraft);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  if (e.key === 'Escape') {
                    setDescDraft(description);
                    setEditingDesc(false);
                  }
                }}
                placeholder={t('addDescriptionPlaceholder')}
                // block: 実ブラウザで計測すると、表示用 <p> と編集用 <input> は
                // line-height、font-size、height、padding、border、margin が完全に
                // 一致しているにもかかわらず、上端の位置だけ 3px ずれていた
                // （Chromium 実測: <p> は top 107px、無指定の <input> は top 110px）。
                // 原因は line-height ではなく display の違いにある。<input> は既定で
                // display: inline-block のため、親 div はインラインフォーマッティング
                // コンテキストを作り、匿名 line box の strut（親の line-height を基準にした
                // 仮想の行の高さ）ぶんだけ input の上に余白が入る。block を指定して
                // インラインフォーマッティングコンテキストへの参加を止めると、<p> と同じ
                // margin ベースの配置になり、実測でも上端が一致した。
                className="mt-0.5 block w-full bg-transparent text-sm text-ink-muted focus:outline-none"
              />
            )
          ) : (
            <p
              className="mt-0.5 cursor-text text-sm text-ink-muted"
              title={t('clickToEditDescriptionTitle')}
              onClick={() => {
                setDescDraft(description);
                setEditingDesc(true);
              }}
            >
              {description || (
                <span className="text-ink-subtle italic">{t('addDescriptionPlaceholder')}</span>
              )}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* GitHub 同期ステータス (連携有効時のみ表示される)。 */}
          {gitControl}
          {readOnly && (
            <span className="rounded-full bg-surface-sunken px-2.5 py-0.5 font-mono text-2xs text-ink-muted">
              {t('readOnlyBadge')}
            </span>
          )}
          {canShare && (
            <Button variant="ghost" size="sm" icon={Share2} onClick={onShare}>
              {t('shareButton')}
            </Button>
          )}
        </div>
      </div>
    </header>
  );
}

/**
 * ノートブック内の1セル分の行。左のステータス枠（CellFrame）、ツールバー、
 * 本文（SQL エディタまたは Markdown）をまとめ、ドラッグ&ドロップ用のハンドラを
 * SqlCell / CellToolbar に配線する。セルの並べ替えはドラッグハンドルのみで行う
 * （上下移動ボタンはグリップハンドルと操作が重複していたため撤去した）。
 * @param cell - 描画対象のセルデータ。
 * @param context - クエリ実行のカタログ／スキーマ／ノートブック ID。
 * @param defaultLimit - LIMIT 自動付与の既定件数。
 * @param resolveUnit - 実行直前に変数を解決するコールバック（NotebookView から供給）。
 * @param variableValues - ライブ見積もり等で使う変数値マップ。
 * @param editingMarkdown - この Markdown セルが編集モードかどうか。
 * @param onStartEditMarkdown - Markdown 編集モードを開始する。
 * @param onCommitMarkdown - Markdown 編集を確定して閲覧モードへ戻す。
 * @param onFocus - このセルがフォーカスされたときに呼ばれる（アクティブセル追跡用）。
 * @param onSourceChange - セル本文が変更されたときに呼ばれる。
 * @param onRename - セル名変更時に呼ばれる。
 * @param onToggleCollapse - 折りたたみ状態の切り替え。
 * @param onDelete - このセルの削除を要求する（確認は呼び出し元が行う）。
 * @param onDragStart - グリップハンドルからのドラッグ開始通知。
 * @param onDragEnd - ドラッグ終了通知。
 */
/** One cell row: status frame + toolbar + body (SQL editor or markdown). */
function CellRow({
  cell,
  context,
  defaultLimit,
  costEstimateEnabled,
  trinoLanguage,
  resolveUnit,
  variableValues,
  editingMarkdown,
  onStartEditMarkdown,
  onCommitMarkdown,
  onFocus,
  onSourceChange,
  onRename,
  onToggleCollapse,
  onDelete,
  onDragStart,
  onDragEnd,
}: {
  cell: Cell;
  context: ExecutionContext;
  defaultLimit: number;
  costEstimateEnabled: boolean;
  trinoLanguage: boolean;
  resolveUnit: (unit: ExecutionUnit) => ExecutionUnit | null;
  variableValues: Record<string, string>;
  editingMarkdown: boolean;
  onStartEditMarkdown: () => void;
  onCommitMarkdown: () => void;
  onFocus: () => void;
  onSourceChange: (source: string) => void;
  onRename: (name: string) => void;
  onToggleCollapse: () => void;
  onDelete: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const status = useCellStatus(cell.id);
  const collapsed = Boolean(cell.collapsed);
  // ドラッグ中はこのセルを半透明にするための見た目専用フラグ（並べ替えの実データは
  // NotebookView 側の dragIndex ref が持つ）。
  const [dragging, setDragging] = useState(false);

  // グリップハンドル（GripVertical アイコン）に付与するネイティブ D&D 属性一式。
  // draggable な要素にこれを spread するだけでドラッグ開始/終了を検知できる。
  const dragHandleProps: React.HTMLAttributes<HTMLSpanElement> & { draggable?: boolean } = {
    draggable: true,
    onDragStart: (e) => {
      e.dataTransfer.effectAllowed = 'move';
      // Some browsers need data set to start a drag.
      // 一部ブラウザは dataTransfer にデータをセットしないとドラッグが開始しないための保険。
      e.dataTransfer.setData('text/plain', cell.id);
      setDragging(true);
      onDragStart();
    },
    onDragEnd: () => {
      setDragging(false);
      onDragEnd();
    },
  };

  // CellToolbar / SqlCell へ渡す「セル操作系」ハンドラをまとめたオブジェクト。
  // NotebookView から降りてきた個々のコールバックをこの1オブジェクトに集約することで
  // SqlCell 側の props を簡潔に保つ。
  const chrome: SqlCellChrome = {
    onToggleCollapse,
    onRename,
    onDelete,
    dragHandleProps,
  };

  return (
    <CellFrame status={status} className={dragging ? 'opacity-60' : undefined}>
      {cell.kind === 'sql' ? (
        // SQL セル：エディタ本体、実行、結果表示をすべて SqlCell に委譲する。
        <SqlCell
          cellId={cell.id}
          source={cell.source}
          name={cell.name}
          collapsed={collapsed}
          resultMeta={cell.resultMeta}
          onSourceChange={onSourceChange}
          onFocus={onFocus}
          context={context}
          defaultLimit={defaultLimit}
          costEstimateEnabled={costEstimateEnabled}
          trinoLanguage={trinoLanguage}
          resolveUnit={resolveUnit}
          variableValues={variableValues}
          chrome={chrome}
        />
      ) : (
        // Markdown セル：ツールバーはここで直接描画し、本文は折りたたまれていなければ
        // MarkdownCell（閲覧/編集の切り替え）に委譲する。
        <div onMouseDown={onFocus}>
          <CellToolbar
            kind="markdown"
            name={cell.name}
            collapsed={collapsed}
            onToggleCollapse={onToggleCollapse}
            onRename={onRename}
            onDelete={onDelete}
            dragHandleProps={dragHandleProps}
          />
          {!collapsed && (
            <MarkdownCell
              source={cell.source}
              editing={editingMarkdown}
              onStartEdit={onStartEditMarkdown}
              onChange={onSourceChange}
              onCommit={onCommitMarkdown}
            />
          )}
        </div>
      )}
    </CellFrame>
  );
}
