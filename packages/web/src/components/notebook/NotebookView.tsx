import { useRef, useState } from 'react';
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
import { NotebookText } from 'lucide-react';
import { toast } from '../common/Toast';
import {
  useCellExecution,
  executionActions,
  isCellRunning,
  allUnits,
  type ExecutionContext,
  type ExecutionUnit,
} from '../../execution';
import {
  useActiveNotebook,
  useNotebookStore,
  substituteVariables,
} from '../../notebook';

/**
 * NotebookView (design.md §6): the active notebook's editable header, variable
 * panel, and cell list. All mutations flow through the notebook store; this
 * component is the orchestrator that wires cell toolbars, drag-reordering,
 * variable substitution and the delete-confirm modal.
 */

interface NotebookViewProps {
  context: { catalog: string; schema: string };
  defaultLimit: number;
}

/** Derive a cell's left-gutter status from its live execution record. */
function useCellStatus(cellId: string): CellStatus {
  const exec = useCellExecution(cellId);
  if (!exec) return 'idle';
  if (isCellRunning(exec)) return 'running';
  if (exec.state === 'finished') return 'finished';
  if (exec.state === 'failed') return 'failed';
  return 'idle';
}

export function NotebookView({ context, defaultLimit }: NotebookViewProps) {
  const entry = useActiveNotebook();
  const store = useNotebookStore;

  const [pendingDelete, setPendingDelete] = useState<Cell | null>(null);
  const [editingMarkdownId, setEditingMarkdownId] = useState<string | null>(null);
  const [activeCellId, setActiveCellId] = useState<string | null>(null);
  const dragIndex = useRef<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  if (!entry) {
    return (
      <div className="mx-auto w-full max-w-4xl px-6 py-16">
        <EmptyState
          icon={NotebookText}
          title="No notebook open"
          description="Create a notebook to start composing SQL cells."
        />
      </div>
    );
  }

  const notebook = entry.notebook;
  const notebookId = notebook.id;
  const cellContext: ExecutionContext = { ...context, notebookId };

  // Build the variable value map for substitution.
  const variableValues: Record<string, string> = {};
  for (const v of notebook.variables) variableValues[v.name] = v.value;

  /** Substitute notebook variables into a unit before it runs (design.md §5). */
  const resolveUnit = (unit: ExecutionUnit): ExecutionUnit | null => {
    const { text, missing } = substituteVariables(unit.text, variableValues);
    if (missing.length > 0) {
      toast.error(
        'Missing variable value',
        `Provide a value for ${missing.map((m) => `\${${m}}`).join(', ')} before running.`,
      );
      return null;
    }
    return { ...unit, text };
  };

  const handleAdd = (
    kind: 'sql' | 'markdown',
    position: 'end' | { relativeTo: string; where: 'above' | 'below' },
  ) => {
    const id = store.getState().addCell(notebookId, kind, position);
    if (kind === 'markdown') setEditingMarkdownId(id);
  };

  const confirmDelete = (cell: Cell) => {
    // Only prompt when the cell has content (design.md §5: 内容ありは確認).
    if (cell.source.trim() === '') {
      doDelete(cell.id);
    } else {
      setPendingDelete(cell);
    }
  };

  const doDelete = (cellId: string) => {
    executionActions().clear(cellId); // P3b handoff: free the execution record
    store.getState().removeCell(notebookId, cellId);
    setPendingDelete(null);
    if (editingMarkdownId === cellId) setEditingMarkdownId(null);
  };

  /** Run the active cell (used by the variable panel's Ctrl/Cmd+Enter). */
  const runActiveCell = () => {
    const nb = store.getState().open[notebookId]?.notebook;
    if (!nb) return;
    const targetId =
      activeCellId && nb.cells.some((c) => c.id === activeCellId)
        ? activeCellId
        : nb.cells.find((c) => c.kind === 'sql')?.id;
    if (!targetId) return;
    const cell = nb.cells.find((c) => c.id === targetId);
    if (!cell || cell.kind !== 'sql') return;
    runCellById(cell, cellContext, defaultLimit, variableValues);
  };

  // ---- Drag and drop (native, on the grip handle) ----
  const onDrop = (toIndex: number) => {
    const from = dragIndex.current;
    setDragOverIndex(null);
    dragIndex.current = null;
    if (from === null || from === toIndex) return;
    store.getState().moveCell(notebookId, from, toIndex);
  };

  const cells = notebook.cells;

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-6">
      <NotebookHeader
        name={notebook.name}
        description={notebook.description}
        onRename={(name) => store.getState().renameNotebook(notebookId, name)}
        onDescribe={(d) => store.getState().setDescription(notebookId, d)}
      />

      <VariablePanel
        variables={notebook.variables}
        onChange={(name, value) => store.getState().setVariableValue(notebookId, name, value)}
        onRunActive={runActiveCell}
      />

      <div className="flex flex-col">
        <CellInsert
          onAddSql={() => handleAdd('sql', cells.length ? { relativeTo: cells[0]!.id, where: 'above' } : 'end')}
          onAddMarkdown={() => handleAdd('markdown', cells.length ? { relativeTo: cells[0]!.id, where: 'above' } : 'end')}
        />
        {cells.map((cell, index) => (
          <div
            key={cell.id}
            data-testid="notebook-cell"
            onDragOver={(e) => {
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
            <CellRow
              cell={cell}
              index={index}
              total={cells.length}
              context={cellContext}
              defaultLimit={defaultLimit}
              resolveUnit={resolveUnit}
              editingMarkdown={editingMarkdownId === cell.id}
              onStartEditMarkdown={() => setEditingMarkdownId(cell.id)}
              onCommitMarkdown={() => setEditingMarkdownId(null)}
              onFocus={() => setActiveCellId(cell.id)}
              onSourceChange={(src) => store.getState().setCellSource(notebookId, cell.id, src)}
              onRename={(name) => store.getState().setCellName(notebookId, cell.id, name)}
              onToggleCollapse={() => store.getState().toggleCellCollapsed(notebookId, cell.id)}
              onMoveUp={() => store.getState().moveCell(notebookId, index, index - 1)}
              onMoveDown={() => store.getState().moveCell(notebookId, index, index + 1)}
              onDelete={() => confirmDelete(cell)}
              onDragStart={() => {
                dragIndex.current = index;
              }}
              onDragEnd={() => {
                dragIndex.current = null;
                setDragOverIndex(null);
              }}
            />
            <CellInsert
              onAddSql={() => handleAdd('sql', { relativeTo: cell.id, where: 'below' })}
              onAddMarkdown={() => handleAdd('markdown', { relativeTo: cell.id, where: 'below' })}
            />
          </div>
        ))}
      </div>

      <Modal
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title="Delete cell?"
        description={
          pendingDelete
            ? `This ${pendingDelete.kind === 'sql' ? 'SQL' : 'Markdown'} cell has content. Deleting it cannot be undone.`
            : undefined
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => pendingDelete && doDelete(pendingDelete.id)}
            >
              Delete cell
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
    </div>
  );
}

/** Imperatively run all statements of a SQL cell with substitution applied. */
function runCellById(
  cell: Cell,
  context: ExecutionContext,
  defaultLimit: number,
  values: Record<string, string>,
): void {
  if (cell.kind !== 'sql') return;
  const opts = { autoLimit: true, limit: defaultLimit };
  const resolved: ExecutionUnit[] = [];
  for (const u of allUnits(cell.source)) {
    const { text, missing } = substituteVariables(u.text, values);
    if (missing.length > 0) {
      toast.error(
        'Missing variable value',
        `Provide a value for ${missing.map((m) => `\${${m}}`).join(', ')}.`,
      );
      return;
    }
    resolved.push({ ...u, text });
  }
  if (resolved.length === 0) return;
  if (resolved.length === 1) executionActions().runUnit(cell.id, resolved[0]!, context, opts);
  else void executionActions().runUnits(cell.id, resolved, context, opts);
}

/** Editable notebook title + description (design.md §6 NotebookView ヘッダー). */
function NotebookHeader({
  name,
  description,
  onRename,
  onDescribe,
}: {
  name: string;
  description: string;
  onRename: (name: string) => void;
  onDescribe: (description: string) => void;
}) {
  const [editingName, setEditingName] = useState(false);
  const [editingDesc, setEditingDesc] = useState(false);
  const [nameDraft, setNameDraft] = useState(name);
  const [descDraft, setDescDraft] = useState(description);

  return (
    <header className="mb-4">
      {editingName ? (
        <input
          autoFocus
          value={nameDraft}
          aria-label="Notebook name"
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
      ) : (
        <h1
          className="cursor-text text-lg font-semibold text-ink-strong"
          title="Click to rename"
          onClick={() => {
            setNameDraft(name);
            setEditingName(true);
          }}
        >
          {name}
        </h1>
      )}

      {editingDesc ? (
        <input
          autoFocus
          value={descDraft}
          aria-label="Notebook description"
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
          placeholder="Add a description…"
          className="mt-0.5 w-full bg-transparent text-sm text-ink-muted focus:outline-none"
        />
      ) : (
        <p
          className="mt-0.5 cursor-text text-sm text-ink-muted"
          title="Click to edit description"
          onClick={() => {
            setDescDraft(description);
            setEditingDesc(true);
          }}
        >
          {description || <span className="text-ink-subtle italic">Add a description…</span>}
        </p>
      )}
    </header>
  );
}

/** One cell row: status frame + toolbar + body (SQL editor or markdown). */
function CellRow({
  cell,
  index,
  total,
  context,
  defaultLimit,
  resolveUnit,
  editingMarkdown,
  onStartEditMarkdown,
  onCommitMarkdown,
  onFocus,
  onSourceChange,
  onRename,
  onToggleCollapse,
  onMoveUp,
  onMoveDown,
  onDelete,
  onDragStart,
  onDragEnd,
}: {
  cell: Cell;
  index: number;
  total: number;
  context: ExecutionContext;
  defaultLimit: number;
  resolveUnit: (unit: ExecutionUnit) => ExecutionUnit | null;
  editingMarkdown: boolean;
  onStartEditMarkdown: () => void;
  onCommitMarkdown: () => void;
  onFocus: () => void;
  onSourceChange: (source: string) => void;
  onRename: (name: string) => void;
  onToggleCollapse: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const status = useCellStatus(cell.id);
  const collapsed = Boolean(cell.collapsed);
  const [dragging, setDragging] = useState(false);

  const dragHandleProps: React.HTMLAttributes<HTMLSpanElement> & { draggable?: boolean } = {
    draggable: true,
    onDragStart: (e) => {
      e.dataTransfer.effectAllowed = 'move';
      // Some browsers need data set to start a drag.
      e.dataTransfer.setData('text/plain', cell.id);
      setDragging(true);
      onDragStart();
    },
    onDragEnd: () => {
      setDragging(false);
      onDragEnd();
    },
  };

  const chrome: SqlCellChrome = {
    canMoveUp: index > 0,
    canMoveDown: index < total - 1,
    onToggleCollapse,
    onRename,
    onMoveUp,
    onMoveDown,
    onDelete,
    dragHandleProps,
  };

  return (
    <CellFrame status={status} className={dragging ? 'opacity-60' : undefined}>
      {cell.kind === 'sql' ? (
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
          resolveUnit={resolveUnit}
          chrome={chrome}
        />
      ) : (
        <div onMouseDown={onFocus}>
          <CellToolbar
            kind="markdown"
            name={cell.name}
            collapsed={collapsed}
            canMoveUp={index > 0}
            canMoveDown={index < total - 1}
            onToggleCollapse={onToggleCollapse}
            onRename={onRename}
            onMoveUp={onMoveUp}
            onMoveDown={onMoveDown}
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
