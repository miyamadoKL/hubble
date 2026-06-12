import { useState } from 'react';
import type { SavedQuery } from '@hubble/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookMarked, FilePlus2, Star, TextCursorInput, Trash2 } from 'lucide-react';
import {
  listSavedQueries,
  updateSavedQuery,
  deleteSavedQuery,
} from '../../api/savedQueries';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { insertAtActiveCursor, addSqlCellWithSource } from '../../notebook';
import { EmptyState } from '../common/EmptyState';
import { Spinner } from '../common/Spinner';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { toast } from '../common/Toast';
import { cn } from '../../utils/cn';

/**
 * Saved queries panel (design.md §5: 一覧 / 検索 / お気に入りトグル / 削除 /
 * 詳細 / 挿入). Self-contained: fetches its own list (debounced search), and
 * mutates favorites / deletions through the saved-query API, invalidating the
 * list on success. Insert drops the statement at the caret; "New cell" appends a
 * fresh SQL cell.
 */

const savedQueriesKey = (q: string) => ['saved-queries', 'list', q] as const;

function SavedRow({
  query,
  expanded,
  onToggleExpand,
  onToggleFavorite,
  onInsert,
  onNewCell,
  onDelete,
}: {
  query: SavedQuery;
  expanded: boolean;
  onToggleExpand: () => void;
  onToggleFavorite: () => void;
  onInsert: () => void;
  onNewCell: () => void;
  onDelete: () => void;
}) {
  const oneLine = query.statement.replace(/\s+/g, ' ').trim();
  return (
    <li className="group border-b border-border-subtle">
      <div className="flex items-start gap-2 px-3 py-2 transition-colors hover:bg-surface-sunken">
        <button
          type="button"
          aria-label={query.isFavorite ? 'Unfavorite' : 'Favorite'}
          aria-pressed={query.isFavorite}
          onClick={onToggleFavorite}
          className="mt-0.5 shrink-0 rounded-sm p-0.5"
        >
          <Star
            size={14}
            strokeWidth={1.75}
            className={cn(
              query.isFavorite ? 'fill-accent text-accent' : 'text-ink-subtle hover:text-ink-muted',
            )}
          />
        </button>
        <button
          type="button"
          onClick={onToggleExpand}
          className="min-w-0 flex-1 text-left"
          aria-expanded={expanded}
        >
          <p className="truncate text-sm font-medium text-ink-strong">{query.name}</p>
          <p className="mt-0.5 truncate font-mono text-2xs text-ink-subtle">{oneLine}</p>
          {query.description && (
            <p className="mt-0.5 truncate text-xs text-ink-muted">{query.description}</p>
          )}
        </button>
      </div>

      {expanded && (
        <div className="px-3 pb-2.5">
          <pre className="max-h-40 overflow-auto rounded-md border border-border-subtle bg-surface-sunken px-2.5 py-2 font-mono text-2xs whitespace-pre-wrap text-ink-base">
            {query.statement}
          </pre>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button variant="default" size="sm" icon={TextCursorInput} onClick={onInsert}>
              Insert
            </Button>
            <Button variant="ghost" size="sm" icon={FilePlus2} onClick={onNewCell}>
              New cell
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon={Trash2}
              onClick={onDelete}
              className="ml-auto text-ink-subtle hover:text-error"
            >
              Delete
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

export function SavedQueriesPanel({ search }: { search: string }) {
  const queryClient = useQueryClient();
  const debounced = useDebouncedValue(search.trim(), 300);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<SavedQuery | null>(null);

  const list = useQuery({
    queryKey: savedQueriesKey(debounced),
    queryFn: () => listSavedQueries(debounced || undefined),
  });

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: ['saved-queries', 'list'] });

  const favorite = useMutation({
    mutationFn: (q: SavedQuery) =>
      updateSavedQuery(q.id, {
        name: q.name,
        description: q.description,
        statement: q.statement,
        catalog: q.catalog,
        schema: q.schema,
        isFavorite: !q.isFavorite,
      }),
    onSuccess: invalidate,
    onError: () => toast.error('Update failed', 'Could not reach the server.'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteSavedQuery(id),
    onSuccess: () => {
      invalidate();
      toast.info('Deleted', 'Saved query removed.');
    },
    onError: () => toast.error('Delete failed', 'Could not reach the server.'),
  });

  if (list.isPending) {
    return (
      <div className="flex items-center justify-center gap-2 py-8 font-mono text-2xs text-ink-subtle">
        <Spinner size={14} /> Loading…
      </div>
    );
  }

  if (list.isError) {
    return (
      <EmptyState
        icon={BookMarked}
        title="Couldn't load saved queries"
        description="The server didn't respond."
        compact
      />
    );
  }

  const queries = list.data;
  if (queries.length === 0) {
    return (
      <EmptyState
        icon={BookMarked}
        title={debounced ? 'No matches' : 'No saved queries'}
        description={
          debounced
            ? 'Try a different search term.'
            : 'Save a query from a cell to find it here.'
        }
        compact
      />
    );
  }

  // Favorites first, then by name.
  const sorted = [...queries].sort((a, b) => {
    if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <>
      <ul className="flex flex-col">
        {sorted.map((query) => (
          <SavedRow
            key={query.id}
            query={query}
            expanded={expandedId === query.id}
            onToggleExpand={() => setExpandedId((id) => (id === query.id ? null : query.id))}
            onToggleFavorite={() => favorite.mutate(query)}
            onInsert={() => insertAtActiveCursor(query.statement)}
            onNewCell={() => {
              if (addSqlCellWithSource(query.statement)) {
                toast.success('New SQL cell', `“${query.name}” added.`);
              }
            }}
            onDelete={() => setPendingDelete(query)}
          />
        ))}
      </ul>

      <Modal
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title="Delete saved query?"
        description={
          pendingDelete
            ? `“${pendingDelete.name}” will be permanently removed.`
            : undefined
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (pendingDelete) remove.mutate(pendingDelete.id);
                setPendingDelete(null);
              }}
            >
              Delete
            </Button>
          </>
        }
      />
    </>
  );
}
