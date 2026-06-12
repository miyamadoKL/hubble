import { useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { QueryColumn } from '@hue-fable/contracts';
import { ArrowDown, ArrowUp, Columns3, Search, X } from 'lucide-react';
import { IconButton } from '../common/IconButton';
import { cn } from '../../utils/cn';
import { formatDecimal, formatInt } from '../../utils/format';
import type { ResultRow } from '../../execution';

/**
 * High-density virtualized result grid (design.md §6): fixed header, row-number
 * column, 28px rows, mono numerics, column type labels. Rows stream in (the
 * parent passes a growing array). Client-side sort/filter operate over the rows
 * currently loaded — additional rows keep streaming in underneath. NULL is
 * rendered as a muted `NULL` token so it is visually distinct from empty text.
 */

const ROW_HEIGHT = 28;
const HEADER_HEIGHT = 28;
const OVERSCAN = 12;
const NUMERIC_TYPES = /^(bigint|integer|int|smallint|tinyint|double|real|decimal|float)/i;
const DECIMAL_TYPES = /^(double|real|decimal|float)/i;

function isNumericType(type: string): boolean {
  return NUMERIC_TYPES.test(type);
}

interface RenderedValue {
  text: string;
  isNull: boolean;
}

function renderValue(value: unknown, type: string): RenderedValue {
  if (value === null || value === undefined) return { text: 'NULL', isNull: true };
  if (typeof value === 'number') {
    return { text: DECIMAL_TYPES.test(type) ? formatDecimal(value) : formatInt(value), isNull: false };
  }
  if (typeof value === 'boolean') return { text: value ? 'true' : 'false', isNull: false };
  if (typeof value === 'object') return { text: JSON.stringify(value), isNull: false };
  return { text: String(value), isNull: false };
}

/** Lowercased string projection of a cell, for filtering. */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value).toLowerCase();
  return String(value).toLowerCase();
}

type SortDir = 'asc' | 'desc';
interface SortState {
  colIndex: number;
  dir: SortDir;
}

function compareValues(a: unknown, b: unknown, numeric: boolean): number {
  const an = a === null || a === undefined;
  const bn = b === null || b === undefined;
  if (an && bn) return 0;
  if (an) return -1; // nulls first
  if (bn) return 1;
  if (numeric) return Number(a) - Number(b);
  return String(a).localeCompare(String(b));
}

interface ResultGridProps {
  columns: QueryColumn[];
  rows: ReadonlyArray<ResultRow>;
  className?: string;
}

export function ResultGrid({ columns, rows, className }: ResultGridProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [hidden, setHidden] = useState<ReadonlySet<number>>(() => new Set());
  const [colMenuOpen, setColMenuOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [showFilter, setShowFilter] = useState(false);
  const [sort, setSort] = useState<SortState | null>(null);

  const visibleColumns = useMemo(
    () => columns.map((c, i) => ({ col: c, index: i })).filter(({ index }) => !hidden.has(index)),
    [columns, hidden],
  );

  // Filter (client-side, over loaded rows) then sort (stable, loaded range).
  const view = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    let result: { row: ResultRow; sourceIndex: number }[] = rows.map((row, i) => ({
      row,
      sourceIndex: i,
    }));
    if (needle) {
      result = result.filter(({ row }) => row.some((cell) => cellText(cell).includes(needle)));
    }
    if (sort) {
      const numeric = isNumericType(columns[sort.colIndex]?.type ?? '');
      const factor = sort.dir === 'asc' ? 1 : -1;
      result = result
        .map((entry, i) => ({ entry, i }))
        .sort((x, y) => {
          const cmp = compareValues(
            x.entry.row[sort.colIndex],
            y.entry.row[sort.colIndex],
            numeric,
          );
          return cmp !== 0 ? cmp * factor : x.i - y.i; // stable
        })
        .map(({ entry }) => entry);
    }
    return result;
  }, [rows, filter, sort, columns]);

  // TanStack Virtual returns fresh function identities each render; the React
  // Compiler rule flags it as un-memoizable. That is expected and harmless here
  // (we don't pass the virtualizer's functions into memoized children).
  // eslint-disable-next-line react-hooks/incompatible-library
  const rowVirtualizer = useVirtualizer({
    count: view.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
  });

  const toggleColumn = (index: number) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const toggleSort = (colIndex: number) => {
    setSort((prev) => {
      if (!prev || prev.colIndex !== colIndex) return { colIndex, dir: 'asc' };
      if (prev.dir === 'asc') return { colIndex, dir: 'desc' };
      return null; // third click clears
    });
  };

  // Grid template: row-number column + one column per visible field.
  const gridTemplate = `3.25rem ${visibleColumns
    .map(({ col }) => (isNumericType(col.type) ? 'minmax(7rem, max-content)' : 'minmax(9rem, max-content)'))
    .join(' ')}`;

  const virtualRows = rowVirtualizer.getVirtualItems();

  return (
    <div className={cn('flex flex-col', className)}>
      {/* Grid toolbar: column menu + filter. */}
      <div className="flex items-center gap-1 border-b border-border-subtle bg-surface-base px-2 py-1">
        <div className="relative">
          <IconButton
            icon={Columns3}
            label="Show / hide columns"
            size="sm"
            active={hidden.size > 0}
            onClick={() => setColMenuOpen((o) => !o)}
          />
          {colMenuOpen && (
            <ColumnMenu
              columns={columns}
              hidden={hidden}
              onToggle={toggleColumn}
              onClose={() => setColMenuOpen(false)}
            />
          )}
        </div>
        <IconButton
          icon={Search}
          label="Filter rows"
          size="sm"
          active={showFilter || filter.length > 0}
          onClick={() => setShowFilter((s) => !s)}
        />
        {showFilter && (
          <div className="relative flex-1">
            <input
              autoFocus
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter loaded rows…"
              aria-label="Filter rows"
              className={cn(
                'h-6 w-full rounded-sm border border-border-base bg-surface-raised px-2 pr-6',
                'font-mono text-2xs text-ink-base placeholder:text-ink-subtle',
                'focus-visible:border-accent focus-visible:outline-none',
              )}
            />
            {filter && (
              <button
                type="button"
                aria-label="Clear filter"
                onClick={() => setFilter('')}
                className="absolute top-1/2 right-1 -translate-y-1/2 text-ink-subtle hover:text-ink-strong"
              >
                <X size={12} strokeWidth={2} />
              </button>
            )}
          </div>
        )}
        <span className="ml-auto font-mono text-2xs text-ink-subtle tabular-nums">
          {filter ? `${formatInt(view.length)} / ` : ''}
          {formatInt(rows.length)} loaded
        </span>
      </div>

      {/* Virtualized scroll body with a sticky CSS-grid header. */}
      <div
        ref={scrollRef}
        className="max-h-96 min-h-[8rem] overflow-auto bg-surface-sunken"
        data-testid="result-grid"
      >
        <div style={{ width: 'max-content', minWidth: '100%' }}>
          {/* Header row */}
          <div
            className="sticky top-0 z-10 grid bg-surface-inset"
            style={{ gridTemplateColumns: gridTemplate, height: HEADER_HEIGHT }}
          >
            <div className="flex items-center justify-end border-r border-b border-border-base px-2 font-mono text-2xs text-ink-subtle">
              #
            </div>
            {visibleColumns.map(({ col, index }) => {
              const numeric = isNumericType(col.type);
              const sorted = sort?.colIndex === index ? sort.dir : undefined;
              return (
                <button
                  key={index}
                  type="button"
                  onClick={() => toggleSort(index)}
                  title={`${col.name} (${col.type}) — click to sort`}
                  className={cn(
                    'flex items-center gap-1.5 border-r border-b border-border-base px-3',
                    'text-2xs font-semibold tracking-wider text-ink-muted uppercase',
                    'hover:bg-surface-raised',
                    numeric ? 'justify-end text-right' : 'justify-start text-left',
                  )}
                >
                  {numeric && <SortIcon dir={sorted} />}
                  <span className="truncate normal-case">{col.name}</span>
                  <span className="font-mono text-[0.625rem] font-normal tracking-normal text-ink-subtle normal-case">
                    {col.type}
                  </span>
                  {!numeric && <SortIcon dir={sorted} />}
                </button>
              );
            })}
          </div>

          {/* Virtual rows */}
          <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
            {virtualRows.map((vRow) => {
              const entry = view[vRow.index]!;
              return (
                <div
                  key={vRow.key}
                  className="group absolute grid hover:bg-surface-raised"
                  style={{
                    gridTemplateColumns: gridTemplate,
                    height: ROW_HEIGHT,
                    transform: `translateY(${vRow.start}px)`,
                    top: 0,
                    left: 0,
                    width: '100%',
                  }}
                >
                  <div className="flex items-center justify-end border-r border-b border-border-subtle bg-surface-inset px-2 font-mono text-2xs text-ink-subtle select-none group-hover:bg-accent-soft">
                    {entry.sourceIndex + 1}
                  </div>
                  {visibleColumns.map(({ col, index }) => {
                    const numeric = isNumericType(col.type);
                    const rendered = renderValue(entry.row[index], col.type);
                    return (
                      <div
                        key={index}
                        className={cn(
                          'flex items-center overflow-hidden border-r border-b border-border-subtle px-3',
                          'whitespace-nowrap',
                          numeric
                            ? 'justify-end font-mono text-xs tabular-nums text-ink-base'
                            : 'font-mono text-xs text-ink-base',
                          rendered.isNull && 'text-ink-subtle italic',
                        )}
                        title={rendered.text}
                      >
                        <span className="truncate">{rendered.text}</span>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function SortIcon({ dir }: { dir?: SortDir }) {
  if (!dir) return null;
  const Icon = dir === 'asc' ? ArrowUp : ArrowDown;
  return <Icon size={11} strokeWidth={2.25} className="shrink-0 text-accent" />;
}

interface ColumnMenuProps {
  columns: QueryColumn[];
  hidden: ReadonlySet<number>;
  onToggle: (index: number) => void;
  onClose: () => void;
}

function ColumnMenu({ columns, hidden, onToggle, onClose }: ColumnMenuProps) {
  const [search, setSearch] = useState('');
  const filtered = columns
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.name.toLowerCase().includes(search.toLowerCase()));
  return (
    <>
      {/* Click-away backdrop. */}
      <div className="fixed inset-0 z-30" onClick={onClose} aria-hidden />
      <div className="absolute top-7 left-0 z-40 w-60 rounded-md border border-border-base bg-surface-overlay p-1.5 shadow-lg">
        <div className="mb-1.5 flex items-center gap-1.5 rounded-sm border border-border-base bg-surface-raised px-2">
          <Search size={12} strokeWidth={2} className="text-ink-subtle" />
          <input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search columns…"
            aria-label="Search columns"
            className="h-6 flex-1 bg-transparent text-xs text-ink-base placeholder:text-ink-subtle focus:outline-none"
          />
        </div>
        <div className="max-h-56 overflow-auto">
          {filtered.map(({ c, i }) => (
            <label
              key={i}
              className="flex cursor-pointer items-center gap-2 rounded-sm px-1.5 py-1 hover:bg-surface-sunken"
            >
              <input
                type="checkbox"
                checked={!hidden.has(i)}
                onChange={() => onToggle(i)}
                className="accent-accent"
              />
              <span className="truncate text-xs text-ink-base">{c.name}</span>
              <span className="ml-auto font-mono text-[0.625rem] text-ink-subtle">{c.type}</span>
            </label>
          ))}
          {filtered.length === 0 && (
            <p className="px-2 py-2 text-2xs text-ink-subtle">No matching columns.</p>
          )}
        </div>
      </div>
    </>
  );
}
