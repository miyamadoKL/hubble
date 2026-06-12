import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Clock, Database, Search } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import {
  fetchCatalogs,
  fetchSchemas,
  metadataQueryKeys,
  META_STALE_MS,
} from '../../api/metadata';
import { readRecentContexts, type ContextValue } from '../../notebook';
import { Spinner } from '../common/Spinner';
import { cn } from '../../utils/cn';

/**
 * catalog.schema context selector (design.md §6, §5 管理: 実 catalogs/schemas
 * からの選択, 検索付きドロップダウン, 最近使った context). A single instrument-
 * style control opens a searchable two-pane popover: pick a catalog (left), then
 * a schema (right). A "Recent" row offers the last few contexts for one-click
 * restore. Selection flows up via `onChange`; the caller persists it to the
 * active notebook + the recent list.
 */

function useOutsideClose(ref: React.RefObject<HTMLElement | null>, onClose: () => void, open: boolean) {
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [ref, onClose, open]);
}

export function ContextSelector({
  catalog,
  schema,
  onChange,
  className,
}: {
  catalog: string;
  schema: string;
  onChange: (next: { catalog: string; schema: string }) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  // Which catalog's schemas are shown in the right pane while picking.
  const [pickCatalog, setPickCatalog] = useState(catalog);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [recents, setRecents] = useState<ContextValue[]>([]);

  useOutsideClose(rootRef, () => setOpen(false), open);

  const catalogs = useQuery({
    queryKey: metadataQueryKeys.catalogs(),
    queryFn: fetchCatalogs,
    staleTime: META_STALE_MS,
    enabled: open,
  });

  const schemas = useQuery({
    queryKey: metadataQueryKeys.schemas(pickCatalog),
    queryFn: () => fetchSchemas(pickCatalog),
    staleTime: META_STALE_MS,
    enabled: open && Boolean(pickCatalog),
  });

  // Focus the search once the popover is open (DOM side effect only — no
  // setState, so it stays clear of the cascading-render rule).
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => searchRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  /** Open the popover, seeding its transient state from current props. */
  const openPopover = () => {
    setRecents(readRecentContexts());
    setPickCatalog(catalog);
    setSearch('');
    setOpen(true);
  };

  const needle = search.trim().toLowerCase();
  const catalogItems = useMemo(
    () => (catalogs.data?.items ?? []).filter((c) => c.name.toLowerCase().includes(needle)),
    [catalogs.data, needle],
  );
  const schemaItems = useMemo(
    () => (schemas.data?.items ?? []).filter((s) => s.name.toLowerCase().includes(needle)),
    [schemas.data, needle],
  );

  const choose = (nextCatalog: string, nextSchema: string) => {
    onChange({ catalog: nextCatalog, schema: nextSchema });
    setOpen(false);
  };

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        type="button"
        aria-label="catalog.schema context"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openPopover())}
        className={cn(
          'flex h-8 items-center gap-1.5 rounded-md border bg-surface-raised px-2.5 text-sm transition-colors',
          open ? 'border-accent ring-1 ring-accent/30' : 'border-border-base hover:bg-surface-sunken',
        )}
      >
        <Database size={14} strokeWidth={1.75} className="shrink-0 text-ink-subtle" />
        <span className="font-mono text-xs text-ink-base">
          {catalog || '—'}
          <span className="text-ink-subtle">.</span>
          {schema || '—'}
        </span>
        <ChevronDown
          size={14}
          strokeWidth={1.75}
          className={cn('shrink-0 text-ink-subtle transition-transform', open && 'rotate-180')}
        />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Select context"
          className="absolute right-0 z-50 mt-1 w-80 overflow-hidden rounded-md border border-border-strong bg-surface-overlay shadow-lg animate-[fadeIn_150ms_ease-out]"
        >
          <div className="flex items-center gap-2 border-b border-border-subtle px-2.5 py-2">
            <Search size={14} strokeWidth={1.75} className="shrink-0 text-ink-subtle" />
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter catalogs / schemas…"
              className="min-w-0 flex-1 bg-transparent text-sm text-ink-base placeholder:text-ink-subtle focus:outline-none"
            />
          </div>

          {recents.length > 0 && !needle && (
            <div className="border-b border-border-subtle px-2 py-1.5">
              <p className="mb-1 px-1 text-2xs font-semibold tracking-[0.12em] text-ink-subtle uppercase">
                Recent
              </p>
              <div className="flex flex-col">
                {recents.map((r) => (
                  <button
                    key={`${r.catalog}.${r.schema}`}
                    type="button"
                    onClick={() => choose(r.catalog, r.schema)}
                    className="flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-left font-mono text-xs text-ink-base hover:bg-surface-sunken"
                  >
                    <Clock size={12} strokeWidth={1.75} className="shrink-0 text-ink-subtle" />
                    {r.catalog}
                    <span className="text-ink-subtle">.</span>
                    {r.schema}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="grid h-56 grid-cols-2">
            {/* Catalogs */}
            <div className="overflow-auto border-r border-border-subtle py-1">
              <p className="px-2.5 pb-1 text-2xs font-semibold tracking-[0.12em] text-ink-subtle uppercase">
                Catalog
              </p>
              {catalogs.isPending && (
                <p className="flex items-center gap-1.5 px-2.5 py-1 font-mono text-2xs text-ink-subtle">
                  <Spinner size={11} /> Loading…
                </p>
              )}
              {catalogs.isError && (
                <p className="px-2.5 py-1 font-mono text-2xs text-error">Failed to load.</p>
              )}
              {catalogItems.map((c) => (
                <button
                  key={c.name}
                  type="button"
                  onMouseEnter={() => setPickCatalog(c.name)}
                  onClick={() => setPickCatalog(c.name)}
                  className={cn(
                    'flex w-full items-center gap-1.5 px-2.5 py-1 text-left font-mono text-xs',
                    c.name === pickCatalog
                      ? 'bg-accent-soft text-accent'
                      : 'text-ink-base hover:bg-surface-sunken',
                  )}
                >
                  <Database size={12} strokeWidth={1.75} className="shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{c.name}</span>
                </button>
              ))}
            </div>

            {/* Schemas of the hovered/selected catalog */}
            <div className="overflow-auto py-1">
              <p className="px-2.5 pb-1 text-2xs font-semibold tracking-[0.12em] text-ink-subtle uppercase">
                Schema
              </p>
              {schemas.isPending && (
                <p className="flex items-center gap-1.5 px-2.5 py-1 font-mono text-2xs text-ink-subtle">
                  <Spinner size={11} /> Loading…
                </p>
              )}
              {schemas.isError && (
                <p className="px-2.5 py-1 font-mono text-2xs text-error">Failed to load.</p>
              )}
              {schemas.data && schemaItems.length === 0 && (
                <p className="px-2.5 py-1 font-mono text-2xs text-ink-subtle italic">
                  {needle ? 'No matches' : 'No schemas'}
                </p>
              )}
              {schemaItems.map((s) => {
                const selected = pickCatalog === catalog && s.name === schema;
                return (
                  <button
                    key={s.name}
                    type="button"
                    onClick={() => choose(pickCatalog, s.name)}
                    className={cn(
                      'w-full px-2.5 py-1 text-left font-mono text-xs',
                      selected
                        ? 'bg-accent-soft text-accent'
                        : 'text-ink-base hover:bg-surface-sunken',
                    )}
                  >
                    {s.name}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
