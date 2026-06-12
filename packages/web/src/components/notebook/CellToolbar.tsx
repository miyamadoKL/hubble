import { useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  GripVertical,
  Play,
  Square,
  Trash2,
} from 'lucide-react';
import { IconButton } from '../common/IconButton';
import { Kbd } from '../common/Kbd';
import { Tooltip } from '../common/Tooltip';
import { cn } from '../../utils/cn';

/**
 * Cell toolbar (design.md §6): collapse / kind badge / editable name, plus run /
 * stop, the LIMIT auto-append toggle (SQL cells, design.md §5), move up/down,
 * delete, and the drag grip handle. Move/delete/rename are notebook-level
 * operations passed down from NotebookView; run/limit are SQL-cell-owned.
 */

interface CellToolbarProps {
  kind: 'sql' | 'markdown';
  name?: string;
  collapsed: boolean;
  running?: boolean;
  /** LIMIT auto-append controls (SQL cells only). */
  autoLimit?: boolean;
  limit?: number;
  /** True when this cell cannot move further in that direction. */
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  onToggleCollapse: () => void;
  onRename: (name: string) => void;
  onRun?: () => void;
  onCancel?: () => void;
  /** Query Guard: disable run (block verdict) and explain why in the tooltip. */
  runDisabled?: boolean;
  runDisabledReason?: string;
  onToggleAutoLimit?: () => void;
  onLimitChange?: (limit: number) => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onDelete?: () => void;
  /** Drag handle props supplied by the DnD container in NotebookView. */
  dragHandleProps?: React.HTMLAttributes<HTMLSpanElement>;
}

export function CellToolbar({
  kind,
  name,
  collapsed,
  running = false,
  autoLimit = true,
  limit = 5000,
  canMoveUp = true,
  canMoveDown = true,
  onToggleCollapse,
  onRename,
  onRun,
  onCancel,
  runDisabled = false,
  runDisabledReason,
  onToggleAutoLimit,
  onLimitChange,
  onMoveUp,
  onMoveDown,
  onDelete,
  dragHandleProps,
}: CellToolbarProps) {
  return (
    <div className="flex items-center gap-1.5 border-b border-border-subtle bg-surface-raised px-2 py-1.5">
      <button
        type="button"
        aria-label={collapsed ? 'Expand cell' : 'Collapse cell'}
        onClick={onToggleCollapse}
        className="rounded-sm p-0.5 text-ink-subtle hover:text-ink-strong"
      >
        {collapsed ? (
          <ChevronRight size={14} strokeWidth={2} />
        ) : (
          <ChevronDown size={14} strokeWidth={2} />
        )}
      </button>

      <span
        className={cn(
          'rounded-xs px-1.5 py-0.5 font-mono text-2xs font-medium tracking-wide uppercase',
          kind === 'sql' ? 'bg-accent-soft text-accent' : 'bg-surface-inset text-ink-muted',
        )}
      >
        {kind}
      </span>

      <CellName name={name} onRename={onRename} />

      <div className="ml-auto flex items-center gap-1.5">
        {kind === 'sql' && (
          <LimitControl
            autoLimit={autoLimit}
            limit={limit}
            onToggle={onToggleAutoLimit}
            onLimitChange={onLimitChange}
          />
        )}
        {kind === 'sql' && (
          <Tooltip
            label={
              running ? (
                <span className="flex items-center gap-1.5">
                  Stop <Kbd keys={['Ctrl', '↵']} />
                </span>
              ) : runDisabled ? (
                // Query Guard block: explain why the run is unavailable.
                <span className="block max-w-xs whitespace-normal text-left">
                  {runDisabledReason ?? 'Blocked by Query Guard'}
                </span>
              ) : (
                <span className="flex items-center gap-1.5">
                  Run cell <Kbd keys={['Ctrl', '↵']} />
                </span>
              )
            }
          >
            {running ? (
              <IconButton
                icon={Square}
                label="Stop"
                variant="danger"
                size="sm"
                tooltip={false}
                onClick={onCancel}
              />
            ) : (
              <IconButton
                icon={Play}
                label={runDisabled ? 'Run blocked by Query Guard' : 'Run cell'}
                variant="accent"
                size="sm"
                tooltip={false}
                disabled={runDisabled}
                onClick={onRun}
              />
            )}
          </Tooltip>
        )}
        <IconButton
          icon={ChevronUp}
          label="Move up"
          size="sm"
          disabled={!canMoveUp}
          onClick={onMoveUp}
        />
        <IconButton
          icon={ChevronDown}
          label="Move down"
          size="sm"
          disabled={!canMoveDown}
          onClick={onMoveDown}
        />
        <IconButton
          icon={Trash2}
          label="Delete cell"
          variant="danger"
          size="sm"
          onClick={onDelete}
        />
        <span
          {...dragHandleProps}
          aria-label="Drag to reorder"
          role="button"
          tabIndex={0}
          className="ml-0.5 cursor-grab text-ink-subtle hover:text-ink-muted active:cursor-grabbing"
        >
          <GripVertical size={15} strokeWidth={1.75} />
        </span>
      </div>
    </div>
  );
}

/** Inline-editable cell name: double-click (or the placeholder) to rename. */
function CellName({ name, onRename }: { name?: string; onRename: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name ?? '');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commit = () => {
    setEditing(false);
    onRename(draft.trim());
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        aria-label="Cell name"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') {
            setDraft(name ?? '');
            setEditing(false);
          }
        }}
        placeholder="Cell name"
        className="w-40 bg-transparent text-xs font-medium text-ink-base focus:outline-none"
      />
    );
  }

  return (
    <button
      type="button"
      onDoubleClick={() => {
        setDraft(name ?? '');
        setEditing(true);
      }}
      title="Double-click to rename"
      className={cn(
        // pr-0.5: `truncate` clips at the padding edge, and the final italic
        // glyph of the placeholder leans past its advance width — give the
        // overhang room so "Untitled cell" doesn't lose the tip of its "l".
        'truncate pr-0.5 text-xs font-medium',
        name ? 'text-ink-base' : 'text-ink-subtle italic',
      )}
    >
      {name || 'Untitled cell'}
    </button>
  );
}

/** LIMIT auto-append toggle + inline editable value (design.md §5). */
function LimitControl({
  autoLimit,
  limit,
  onToggle,
  onLimitChange,
}: {
  autoLimit: boolean;
  limit: number;
  onToggle?: () => void;
  onLimitChange?: (limit: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(limit));

  const commit = () => {
    setEditing(false);
    const parsed = Number.parseInt(draft, 10);
    if (Number.isFinite(parsed) && parsed > 0) onLimitChange?.(parsed);
    else setDraft(String(limit));
  };

  return (
    <div
      className={cn(
        'inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 font-mono text-2xs',
        autoLimit
          ? 'border-border-base bg-surface-inset text-ink-muted'
          : 'border-transparent text-ink-subtle',
      )}
    >
      <button
        type="button"
        role="switch"
        aria-checked={autoLimit}
        aria-label="Toggle auto LIMIT"
        onClick={onToggle}
        className="font-semibold tracking-wide uppercase hover:text-ink-strong"
      >
        LIMIT
      </button>
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ''))}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') {
              setDraft(String(limit));
              setEditing(false);
            }
          }}
          aria-label="LIMIT value"
          className="w-14 bg-transparent tabular-nums focus:outline-none"
        />
      ) : (
        <button
          type="button"
          aria-label="Edit LIMIT value"
          onClick={() => {
            setDraft(String(limit));
            setEditing(true);
          }}
          className={cn('tabular-nums hover:text-ink-strong', !autoLimit && 'line-through')}
        >
          {limit.toLocaleString('en-US')}
        </button>
      )}
    </div>
  );
}
