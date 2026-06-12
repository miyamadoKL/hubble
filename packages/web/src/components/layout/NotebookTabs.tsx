import { useEffect, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { cn } from '../../utils/cn';

export interface NotebookTab {
  id: string;
  name: string;
  dirty: boolean;
}

/**
 * Notebook tabs in the TopBar (design.md §6, §5 管理). Each tab selects its
 * notebook, shows a dirty dot when unsaved, closes via the × (the caller
 * confirms for dirty tabs), and renames inline on double-click. The active tab
 * carries the accent underline.
 */
export function NotebookTabs({
  tabs,
  activeId,
  onSelect,
  onClose,
  onRename,
  onNew,
}: {
  tabs: NotebookTab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onNew: () => void;
}) {
  return (
    <div className="flex items-stretch gap-1">
      {tabs.map((tab) => (
        <TabItem
          key={tab.id}
          tab={tab}
          active={tab.id === activeId}
          onSelect={() => onSelect(tab.id)}
          onClose={() => onClose(tab.id)}
          onRename={(name) => onRename(tab.id, name)}
        />
      ))}
      <button
        type="button"
        aria-label="New notebook"
        onClick={onNew}
        className="flex h-8 w-8 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink-strong"
      >
        <Plus size={16} strokeWidth={1.75} />
      </button>
    </div>
  );
}

function TabItem({
  tab,
  active,
  onSelect,
  onClose,
  onRename,
}: {
  tab: NotebookTab;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
  onRename: (name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(tab.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commit = () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== tab.name) onRename(trimmed);
  };

  return (
    <div
      className={cn(
        'group relative flex h-8 items-center gap-2 rounded-md border px-2.5 transition-colors',
        active
          ? 'border-border-base bg-surface-raised text-ink-strong shadow-sm'
          : 'border-transparent text-ink-muted hover:bg-surface-sunken hover:text-ink-base',
      )}
    >
      {tab.dirty && (
        <span
          aria-label="Unsaved changes"
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
        />
      )}
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          aria-label="Rename notebook"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') {
              setDraft(tab.name);
              setEditing(false);
            }
          }}
          className="w-32 bg-transparent text-sm font-medium focus:outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={onSelect}
          onDoubleClick={() => {
            setDraft(tab.name);
            setEditing(true);
          }}
          className="max-w-[10rem] truncate text-sm font-medium"
          title={`${tab.name}${tab.dirty ? ' • unsaved' : ''} (double-click to rename)`}
        >
          {tab.name}
        </button>
      )}
      <button
        type="button"
        aria-label={`Close ${tab.name}`}
        onClick={onClose}
        className={cn(
          'rounded-sm p-0.5 text-ink-subtle transition-opacity hover:text-ink-strong',
          active ? 'opacity-60 hover:opacity-100' : 'opacity-0 group-hover:opacity-60',
        )}
      >
        <X size={13} strokeWidth={2} />
      </button>
      {active && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent" />}
    </div>
  );
}
