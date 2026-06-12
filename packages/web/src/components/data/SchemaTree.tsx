import { useCallback, useMemo, useState } from 'react';
import {
  AlertCircle,
  ChevronRight,
  Database,
  Hash,
  Info,
  Layers,
  RefreshCw,
  Table2,
  Type,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Column } from '@hue-fable/contracts';
import {
  fetchCatalogs,
  fetchSchemas,
  fetchTables,
  fetchTableDetail,
  metadataQueryKeys,
  META_STALE_MS,
  refreshMetadata,
} from '../../api/metadata';
import { insertAtActiveCursor } from '../../notebook';
import { relativeTableName, quoteIdentifier } from './tableName';
import { expandedForFilter, filterByNeedle, schemaKey, type LoadedTree } from './treeFilter';
import { TableDetailPopover, type TableTarget } from './TableDetailPopover';
import { Spinner } from '../common/Spinner';
import { IconButton } from '../common/IconButton';
import { toast } from '../common/Toast';
import { cn } from '../../utils/cn';

/**
 * Data browser tree (design.md §5): catalog → schema → table → column, lazy-
 * loaded on expand (TanStack Query, stale 5 min). A client-side filter narrows
 * already-loaded nodes and auto-expands matched paths; unloaded branches are
 * left collapsed (the filter can't reach them, which is fine). Clicking a table
 * inserts its context-relative name at the caret; clicking a column inserts its
 * name. A per-row info button opens the table detail popover; a header button
 * refreshes the server cache and invalidates the tree.
 */

const NUMERIC = /^(bigint|integer|int|smallint|tinyint|double|real|decimal|float)/i;

function columnIcon(type: string): LucideIcon {
  return NUMERIC.test(type) ? Hash : Type;
}

export interface SchemaTreeContext {
  catalog?: string;
  schema?: string;
}

// ---- Generic row -----------------------------------------------------------

interface TreeRowProps {
  depth: number;
  icon: LucideIcon;
  iconClass?: string;
  label: string;
  meta?: string;
  expandable?: boolean;
  expanded?: boolean;
  selected?: boolean;
  onToggle?: () => void;
  onSelect?: () => void;
  trailing?: React.ReactNode;
}

function TreeRow({
  depth,
  icon: Icon,
  iconClass,
  label,
  meta,
  expandable = false,
  expanded = false,
  selected = false,
  onToggle,
  onSelect,
  trailing,
}: TreeRowProps) {
  return (
    <div
      className={cn(
        'group/row flex h-7 items-center pr-1',
        selected ? 'bg-accent-soft' : 'hover:bg-surface-sunken',
      )}
    >
      <button
        type="button"
        onClick={() => {
          onSelect?.();
          if (expandable) onToggle?.();
        }}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
        className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left text-sm"
      >
        {expandable ? (
          <ChevronRight
            size={13}
            strokeWidth={2}
            className={cn(
              'shrink-0 text-ink-subtle transition-transform',
              expanded && 'rotate-90',
            )}
          />
        ) : (
          <span className="w-[13px] shrink-0" />
        )}
        <Icon
          size={14}
          strokeWidth={1.75}
          className={cn('shrink-0', selected ? 'text-accent' : (iconClass ?? 'text-ink-muted'))}
        />
        <span
          className={cn(
            'min-w-0 flex-1 truncate font-mono text-xs',
            selected ? 'text-accent' : 'text-ink-base',
          )}
        >
          {label}
        </span>
        {meta && <span className="shrink-0 font-mono text-2xs text-ink-subtle">{meta}</span>}
      </button>
      {trailing}
    </div>
  );
}

/** A small inline status line (loading / error / empty) under an open node. */
function NodeStatus({
  depth,
  state,
  onRetry,
  emptyLabel = 'Empty',
}: {
  depth: number;
  state: 'loading' | 'error' | 'empty';
  onRetry?: () => void;
  emptyLabel?: string;
}) {
  return (
    <div
      style={{ paddingLeft: `${depth * 14 + 26}px` }}
      className="flex h-6 items-center gap-1.5 pr-2 font-mono text-2xs text-ink-subtle"
    >
      {state === 'loading' && (
        <>
          <Spinner size={11} /> Loading…
        </>
      )}
      {state === 'empty' && <span className="text-ink-subtle italic">{emptyLabel}</span>}
      {state === 'error' && (
        <>
          <AlertCircle size={11} className="text-error" />
          <span className="text-error">Failed</span>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="text-accent underline-offset-2 hover:underline"
            >
              retry
            </button>
          )}
        </>
      )}
    </div>
  );
}

// ---- Column list (under an expanded table) ---------------------------------

function ColumnList({
  columns,
  depth,
  needle,
  onInsertColumn,
}: {
  columns: Column[];
  depth: number;
  needle: string;
  onInsertColumn: (name: string) => void;
}) {
  const visible = filterByNeedle(columns, (c) => c.name, needle);
  return (
    <>
      {visible.map((col) => (
        <TreeRow
          key={col.name}
          depth={depth}
          icon={columnIcon(col.type)}
          label={col.name}
          meta={col.type}
          onSelect={() => onInsertColumn(col.name)}
        />
      ))}
    </>
  );
}

// ---- Table node ------------------------------------------------------------

function TableNode({
  catalog,
  schema,
  table,
  type,
  depth,
  needle,
  context,
  expanded,
  onToggle,
  onShowDetail,
}: {
  catalog: string;
  schema: string;
  table: string;
  type?: string;
  depth: number;
  needle: string;
  context: SchemaTreeContext;
  expanded: boolean;
  onToggle: () => void;
  onShowDetail: (target: TableTarget) => void;
}) {
  const detail = useQuery({
    queryKey: metadataQueryKeys.table(catalog, schema, table),
    queryFn: () => fetchTableDetail(catalog, schema, table),
    enabled: expanded,
    staleTime: META_STALE_MS,
  });

  const target: TableTarget = { catalog, schema, name: table, type };

  const insertTable = () => {
    const text = relativeTableName({ catalog, schema, name: table }, context);
    insertAtActiveCursor(text);
  };

  return (
    <>
      <TreeRow
        depth={depth}
        icon={Table2}
        iconClass={type === 'VIEW' ? 'text-running' : 'text-ink-muted'}
        label={table}
        expandable
        expanded={expanded}
        onToggle={onToggle}
        onSelect={insertTable}
        trailing={
          <button
            type="button"
            aria-label={`Details for ${table}`}
            onClick={(e) => {
              e.stopPropagation();
              onShowDetail(target);
            }}
            className="shrink-0 rounded-sm p-1 text-ink-subtle opacity-0 transition-opacity group-hover/row:opacity-100 hover:text-accent focus-visible:opacity-100"
          >
            <Info size={13} strokeWidth={1.75} />
          </button>
        }
      />
      {expanded && (
        <>
          {detail.isPending && <NodeStatus depth={depth + 1} state="loading" />}
          {detail.isError && (
            <NodeStatus depth={depth + 1} state="error" onRetry={() => void detail.refetch()} />
          )}
          {detail.data && detail.data.columns.length === 0 && (
            <NodeStatus depth={depth + 1} state="empty" emptyLabel="No columns" />
          )}
          {detail.data && (
            <ColumnList
              columns={detail.data.columns}
              depth={depth + 1}
              needle={needle}
              onInsertColumn={(name) => insertAtActiveCursor(quoteIdentifier(name))}
            />
          )}
        </>
      )}
    </>
  );
}

// ---- Schema node -----------------------------------------------------------

function SchemaNode({
  catalog,
  schema,
  depth,
  needle,
  context,
  expanded,
  expandedKeys,
  toggle,
  onShowDetail,
}: {
  catalog: string;
  schema: string;
  depth: number;
  needle: string;
  context: SchemaTreeContext;
  expanded: boolean;
  expandedKeys: Set<string>;
  toggle: (key: string) => void;
  onShowDetail: (target: TableTarget) => void;
}) {
  const tables = useQuery({
    queryKey: metadataQueryKeys.tables(catalog, schema),
    queryFn: () => fetchTables(catalog, schema),
    enabled: expanded,
    staleTime: META_STALE_MS,
  });

  const visible = useMemo(
    () => filterByNeedle(tables.data?.items ?? [], (t) => t.name, needle),
    [tables.data, needle],
  );

  return (
    <>
      <TreeRow
        depth={depth}
        icon={Layers}
        label={schema}
        meta={tables.data ? String(tables.data.items.length) : undefined}
        expandable
        expanded={expanded}
        onToggle={() => toggle(`${catalog}::${schema}`)}
      />
      {expanded && (
        <>
          {tables.isPending && <NodeStatus depth={depth + 1} state="loading" />}
          {tables.isError && (
            <NodeStatus depth={depth + 1} state="error" onRetry={() => void tables.refetch()} />
          )}
          {tables.data && visible.length === 0 && (
            <NodeStatus
              depth={depth + 1}
              state="empty"
              emptyLabel={needle ? 'No matches' : 'No tables'}
            />
          )}
          {visible.map((t) => {
            const key = `${catalog}::${schema}::${t.name}`;
            return (
              <TableNode
                key={t.name}
                catalog={catalog}
                schema={schema}
                table={t.name}
                type={t.type}
                depth={depth + 1}
                needle={needle}
                context={context}
                expanded={expandedKeys.has(key)}
                onToggle={() => toggle(key)}
                onShowDetail={onShowDetail}
              />
            );
          })}
        </>
      )}
    </>
  );
}

// ---- Catalog node ----------------------------------------------------------

function CatalogNode({
  catalog,
  needle,
  context,
  expanded,
  expandedKeys,
  toggle,
  onShowDetail,
}: {
  catalog: string;
  needle: string;
  context: SchemaTreeContext;
  expanded: boolean;
  expandedKeys: Set<string>;
  toggle: (key: string) => void;
  onShowDetail: (target: TableTarget) => void;
}) {
  const schemas = useQuery({
    queryKey: metadataQueryKeys.schemas(catalog),
    queryFn: () => fetchSchemas(catalog),
    enabled: expanded,
    staleTime: META_STALE_MS,
  });

  return (
    <>
      <TreeRow
        depth={0}
        icon={Database}
        iconClass="text-accent"
        label={catalog}
        meta={schemas.data ? String(schemas.data.items.length) : undefined}
        expandable
        expanded={expanded}
        onToggle={() => toggle(catalog)}
      />
      {expanded && (
        <>
          {schemas.isPending && <NodeStatus depth={1} state="loading" />}
          {schemas.isError && (
            <NodeStatus depth={1} state="error" onRetry={() => void schemas.refetch()} />
          )}
          {schemas.data && schemas.data.items.length === 0 && (
            <NodeStatus depth={1} state="empty" emptyLabel="No schemas" />
          )}
          {(schemas.data?.items ?? []).map((s) => (
            <SchemaNode
              key={s.name}
              catalog={catalog}
              schema={s.name}
              depth={1}
              needle={needle}
              context={context}
              expanded={expandedKeys.has(`${catalog}::${s.name}`)}
              expandedKeys={expandedKeys}
              toggle={toggle}
              onShowDetail={onShowDetail}
            />
          ))}
        </>
      )}
    </>
  );
}

// ---- Root ------------------------------------------------------------------

export function SchemaTree({
  filter = '',
  context = {},
}: {
  filter?: string;
  context?: SchemaTreeContext;
}) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [detailTarget, setDetailTarget] = useState<TableTarget | null>(null);

  const catalogs = useQuery({
    queryKey: metadataQueryKeys.catalogs(),
    queryFn: fetchCatalogs,
    staleTime: META_STALE_MS,
  });

  const toggle = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const refresh = useMutation({
    mutationFn: () => refreshMetadata(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['metadata'] });
      toast.info('Metadata refreshed', 'Schema cache reloaded from Trino.');
    },
    onError: () => toast.error('Refresh failed', 'Could not reach the server.'),
  });

  const needle = filter.trim().toLowerCase();

  // While filtering, auto-expand already-loaded branches that contain a match so
  // the matched table/column surfaces without manual clicking (design.md §5:
  // マッチパスは自動展開). Unloaded branches are untouched — the filter can't see
  // into them, and that's acceptable. The auto-expand math lives in the pure
  // `treeFilter` module (unit-tested); here we just feed it the cached tree.
  const effectiveExpanded = useMemo(() => {
    if (!needle) return expanded;
    const loaded: LoadedTree = { schemasByCatalog: new Map(), tablesBySchema: new Map() };
    for (const cat of catalogs.data?.items ?? []) {
      const schemas = queryClient.getQueryData(metadataQueryKeys.schemas(cat.name)) as
        | { items: { name: string }[] }
        | undefined;
      if (!schemas) continue;
      loaded.schemasByCatalog.set(
        cat.name,
        schemas.items.map((s) => s.name),
      );
      for (const s of schemas.items) {
        const tables = queryClient.getQueryData(metadataQueryKeys.tables(cat.name, s.name)) as
          | { items: { name: string }[] }
          | undefined;
        if (tables) {
          loaded.tablesBySchema.set(
            schemaKey(cat.name, s.name),
            tables.items.map((t) => t.name),
          );
        }
      }
    }
    return expandedForFilter(expanded, needle, loaded);
    // queryClient cache reads are snapshot-in-render; recompute when the needle,
    // the loaded catalogs, or the explicit expansion set changes.
  }, [needle, expanded, catalogs.data, queryClient]);

  return (
    <div>
      <div className="flex items-center justify-between px-3 pb-1">
        <span className="font-mono text-2xs text-ink-subtle">
          {catalogs.data ? `${catalogs.data.items.length} catalogs` : ' '}
        </span>
        <IconButton
          icon={RefreshCw}
          label="Refresh metadata"
          size="sm"
          disabled={refresh.isPending}
          onClick={() => refresh.mutate()}
          className={refresh.isPending ? 'animate-spin' : undefined}
        />
      </div>

      <div className="py-1">
        {catalogs.isPending && <NodeStatus depth={0} state="loading" />}
        {catalogs.isError && (
          <NodeStatus depth={0} state="error" onRetry={() => void catalogs.refetch()} />
        )}
        {catalogs.data && catalogs.data.items.length === 0 && (
          <NodeStatus depth={0} state="empty" emptyLabel="No catalogs" />
        )}
        {(catalogs.data?.items ?? []).map((c) => (
          <CatalogNode
            key={c.name}
            catalog={c.name}
            needle={needle}
            context={context}
            expanded={effectiveExpanded.has(c.name)}
            expandedKeys={effectiveExpanded}
            toggle={toggle}
            onShowDetail={setDetailTarget}
          />
        ))}
      </div>

      {detailTarget && (
        <TableDetailPopover
          target={detailTarget}
          context={context}
          onClose={() => setDetailTarget(null)}
        />
      )}
    </div>
  );
}
