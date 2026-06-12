import { useState } from 'react';
import type { HistoryResponse, QueryHistoryEntry } from '@hue-fable/contracts';
import { useInfiniteQuery } from '@tanstack/react-query';
import { FilePlus2, History, TextCursorInput } from 'lucide-react';
import { fetchHistory, HISTORY_PAGE_SIZE } from '../../api/history';
import { insertAtActiveCursor, addSqlCellWithSource } from '../../notebook';
import { nextOffset, filterToStateParam, type HistoryFilter } from './historyPaging';
import { StateBadge } from '../common/StateBadge';
import { EmptyState } from '../common/EmptyState';
import { Spinner } from '../common/Spinner';
import { Button } from '../common/Button';
import { toast } from '../common/Toast';
import { formatDuration, formatInt, formatRelativeTime } from '../../utils/format';
import { cn } from '../../utils/cn';

/**
 * History panel (design.md §5: offset ページング 50 件, state フィルタチップ, 各行
 * の詳細 + 新規セルへ). Self-contained: drives an offset-paging reducer over
 * `GET /api/history`, auto-refetches the first page on mount (so executions show
 * up), and exposes a state-filter chip row. Each row expands to the full
 * statement + metadata, with insert / new-cell actions.
 */

const FILTERS: { id: HistoryFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'finished', label: 'Finished' },
  { id: 'failed', label: 'Failed' },
  { id: 'canceled', label: 'Canceled' },
  { id: 'running', label: 'Running' },
];

function HistoryRow({
  entry,
  now,
  expanded,
  onToggle,
}: {
  entry: QueryHistoryEntry;
  now: Date;
  expanded: boolean;
  onToggle: () => void;
}) {
  const oneLine = entry.statement.replace(/\s+/g, ' ').trim();
  return (
    <li className="group border-b border-border-subtle">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-start gap-2 px-3 py-2 text-left transition-colors hover:bg-surface-sunken"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <StateBadge state={entry.state} />
            <span className="font-mono text-2xs text-ink-subtle">
              {formatRelativeTime(entry.submittedAt, now)}
            </span>
          </div>
          <p className="mt-1 truncate font-mono text-xs text-ink-base">{oneLine}</p>
          <div className="mt-1 flex items-center gap-3 font-mono text-2xs text-ink-subtle">
            {(entry.catalog || entry.schema) && (
              <span>
                {entry.catalog ?? '—'}.{entry.schema ?? '—'}
              </span>
            )}
            {entry.state === 'finished' && <span>{formatInt(entry.rowCount)} rows</span>}
            <span>{formatDuration(entry.elapsedMs)}</span>
          </div>
          {entry.errorMessage && !expanded && (
            <p className="mt-1 truncate font-mono text-2xs text-error">{entry.errorMessage}</p>
          )}
        </div>
      </button>

      {expanded && (
        <div className="px-3 pb-2.5">
          <pre className="max-h-48 overflow-auto rounded-md border border-border-subtle bg-surface-sunken px-2.5 py-2 font-mono text-2xs whitespace-pre-wrap text-ink-base">
            {entry.statement}
          </pre>
          {entry.errorMessage && (
            <p className="mt-1.5 font-mono text-2xs whitespace-pre-wrap text-error">
              {entry.errorMessage}
            </p>
          )}
          <dl className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-2xs text-ink-subtle">
            {entry.trinoQueryId && (
              <div className="col-span-2 flex gap-2">
                <dt className="text-ink-subtle">query</dt>
                <dd className="truncate text-ink-muted">{entry.trinoQueryId}</dd>
              </div>
            )}
            <div className="flex gap-2">
              <dt>rows</dt>
              <dd className="text-ink-muted">{formatInt(entry.rowCount)}</dd>
            </div>
            <div className="flex gap-2">
              <dt>elapsed</dt>
              <dd className="text-ink-muted">{formatDuration(entry.elapsedMs)}</dd>
            </div>
          </dl>
          <div className="mt-2 flex items-center gap-2">
            <Button
              variant="default"
              size="sm"
              icon={TextCursorInput}
              onClick={() => insertAtActiveCursor(entry.statement)}
            >
              Insert
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon={FilePlus2}
              onClick={() => {
                if (addSqlCellWithSource(entry.statement)) toast.success('New SQL cell');
              }}
            >
              New cell
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

export function HistoryPanel() {
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const now = new Date();

  // Offset paging via useInfiniteQuery (design.md §5: offset ページング 50 件,
  // もっと見る). `getNextPageParam` reuses the same paging math as the reducer.
  // `refetchOnMount: 'always'` re-pulls the first page whenever the panel shows,
  // so freshly-executed queries appear (design.md §5: 自動 refetch).
  const query = useInfiniteQuery({
    queryKey: ['history', filter],
    queryFn: ({ pageParam }) =>
      fetchHistory({
        offset: pageParam,
        limit: HISTORY_PAGE_SIZE,
        state: filterToStateParam(filter),
      }),
    initialPageParam: 0,
    getNextPageParam: (lastPage: HistoryResponse, allPages) => {
      const loaded = allPages.reduce((n, p) => n + p.items.length, 0);
      return nextOffset(loaded, lastPage.total);
    },
    refetchOnMount: 'always',
  });

  // Flatten pages, de-duplicating by id (an overlapping refetch can't double up).
  const items: QueryHistoryEntry[] = [];
  const seen = new Set<string>();
  for (const page of query.data?.pages ?? []) {
    for (const entry of page.items) {
      if (!seen.has(entry.id)) {
        seen.add(entry.id);
        items.push(entry);
      }
    }
  }
  const total = query.data?.pages.at(-1)?.total ?? 0;

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap gap-1 px-3 pb-2">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={cn(
              'rounded-full px-2.5 py-0.5 text-2xs font-medium transition-colors',
              filter === f.id
                ? 'bg-accent-soft text-accent'
                : 'bg-surface-sunken text-ink-muted hover:text-ink-strong',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {query.isError && items.length === 0 ? (
        <EmptyState
          icon={History}
          title="Couldn't load history"
          description="The server didn't respond."
          compact
        />
      ) : items.length === 0 && !query.isPending ? (
        <EmptyState
          icon={History}
          title={filter === 'all' ? 'No history yet' : 'No matching history'}
          description={
            filter === 'all'
              ? 'Executed queries are recorded here automatically.'
              : 'No queries with this state.'
          }
          compact
        />
      ) : (
        <ul className="flex flex-col">
          {items.map((entry) => (
            <HistoryRow
              key={entry.id}
              entry={entry}
              now={now}
              expanded={expandedId === entry.id}
              onToggle={() => setExpandedId((id) => (id === entry.id ? null : entry.id))}
            />
          ))}
        </ul>
      )}

      {(query.isPending || query.isFetchingNextPage) && (
        <div className="flex items-center justify-center gap-2 py-3 font-mono text-2xs text-ink-subtle">
          <Spinner size={13} /> Loading…
        </div>
      )}

      {!query.isFetchingNextPage && query.hasNextPage && (
        <div className="px-3 py-2">
          <Button
            variant="default"
            size="sm"
            className="w-full justify-center"
            onClick={() => void query.fetchNextPage()}
          >
            Load more ({items.length} of {total})
          </Button>
        </div>
      )}
    </div>
  );
}
