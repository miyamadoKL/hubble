import { useEffect } from 'react';
import { AlertCircle, FilePlus2, Table2, X } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import {
  fetchTableDetail,
  fetchTableSample,
  metadataQueryKeys,
  META_STALE_MS,
} from '../../api/metadata';
import { addSqlCellWithSource } from '../../notebook';
import { selectTemplate, type EditorContext } from './tableName';
import { Spinner } from '../common/Spinner';
import { IconButton } from '../common/IconButton';
import { Button } from '../common/Button';
import { toast } from '../common/Toast';
import { cn } from '../../utils/cn';

/**
 * Table detail popover (design.md §5: カラム一覧 + 型 + コメント + サンプル 10 行).
 * Columns come from the (often already cached) table detail; the sample rows are
 * fetched lazily — only when the popover opens — via `GET .../sample`. A
 * "SELECT 雛形を新規セルへ" button adds a `SELECT col1, col2 … FROM t LIMIT 100`
 * cell. Rendered as a centred floating card with a scrim (the sidebar is too
 * narrow to host it inline).
 */

export interface TableTarget {
  catalog: string;
  schema: string;
  name: string;
  type?: string;
}

export function TableDetailPopover({
  target,
  context,
  onClose,
}: {
  target: TableTarget;
  context: EditorContext;
  onClose: () => void;
}) {
  const { catalog, schema, name } = target;

  const detail = useQuery({
    queryKey: metadataQueryKeys.table(catalog, schema, name),
    queryFn: () => fetchTableDetail(catalog, schema, name),
    staleTime: META_STALE_MS,
  });

  // Sample is fetched only while the popover is mounted (design.md §5: 開いた時
  // のみ fetch). It can be slow / large, so a shorter cache window is fine.
  const sample = useQuery({
    queryKey: metadataQueryKeys.sample(catalog, schema, name),
    queryFn: () => fetchTableSample(catalog, schema, name),
    staleTime: 60_000,
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const onSelectTemplate = () => {
    const columns = detail.data?.columns.map((c) => c.name) ?? [];
    const sql = selectTemplate({ catalog, schema, name }, columns, context);
    const cellId = addSqlCellWithSource(sql);
    if (cellId) {
      toast.success('New SQL cell', `SELECT template for ${name} added.`);
      onClose();
    }
  };

  const sampleColumns = sample.data?.columns ?? detail.data?.columns ?? [];

  return (
    <div
      className="fixed inset-0 z-[88] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`${name} details`}
    >
      <button
        type="button"
        aria-label="Close details"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-ink-strong/40 animate-[fadeIn_150ms_ease-out]"
      />
      <div className="relative z-10 flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border-strong bg-surface-overlay shadow-lg animate-[fadeIn_150ms_ease-out]">
        <header className="flex items-center gap-2 border-b border-border-subtle px-4 py-3">
          <Table2 size={15} strokeWidth={1.75} className="text-ink-muted" />
          <span className="min-w-0 flex-1 truncate font-mono text-sm font-medium text-ink-strong">
            {catalog}.{schema}.{name}
          </span>
          <span className="rounded-xs bg-surface-inset px-1.5 py-0.5 text-2xs tracking-wide text-ink-muted uppercase">
            {target.type === 'VIEW' ? 'view' : 'table'}
          </span>
          <Button variant="default" size="sm" icon={FilePlus2} onClick={onSelectTemplate}>
            SELECT template
          </Button>
          <IconButton icon={X} label="Close" size="sm" onClick={onClose} tooltip={false} />
        </header>

        {detail.data?.comment && (
          <p className="border-b border-border-subtle px-4 py-2 text-xs text-ink-muted">
            {detail.data.comment}
          </p>
        )}

        <div className="min-h-0 flex-1 overflow-auto">
          {/* Columns */}
          <section>
            <h3 className="sticky top-0 z-10 bg-surface-overlay px-4 pt-3 pb-1 text-2xs font-semibold tracking-[0.14em] text-ink-muted uppercase">
              Columns
            </h3>
            {detail.isPending && (
              <p className="flex items-center gap-2 px-4 py-3 font-mono text-2xs text-ink-subtle">
                <Spinner size={12} /> Loading columns…
              </p>
            )}
            {detail.isError && (
              <p className="flex items-center gap-1.5 px-4 py-3 font-mono text-2xs text-error">
                <AlertCircle size={12} /> Failed to load columns.
              </p>
            )}
            <ul className="px-2 pb-2">
              {detail.data?.columns.map((col) => (
                <li
                  key={col.name}
                  className="flex h-7 items-center gap-3 rounded-sm px-2 hover:bg-surface-sunken"
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-base">
                    {col.name}
                  </span>
                  {col.comment && (
                    <span className="min-w-0 max-w-[40%] truncate text-2xs text-ink-subtle">
                      {col.comment}
                    </span>
                  )}
                  <span className="shrink-0 font-mono text-2xs text-ink-subtle">{col.type}</span>
                </li>
              ))}
            </ul>
          </section>

          {/* Sample rows */}
          <section className="border-t border-border-subtle">
            <h3 className="sticky top-0 z-10 bg-surface-overlay px-4 pt-3 pb-1 text-2xs font-semibold tracking-[0.14em] text-ink-muted uppercase">
              Sample · 10 rows
            </h3>
            {sample.isPending && (
              <p className="flex items-center gap-2 px-4 py-3 font-mono text-2xs text-ink-subtle">
                <Spinner size={12} /> Loading sample…
              </p>
            )}
            {sample.isError && (
              <p className="flex items-center gap-1.5 px-4 py-3 font-mono text-2xs text-error">
                <AlertCircle size={12} /> Failed to load sample rows.
              </p>
            )}
            {sample.data && sample.data.rows.length === 0 && (
              <p className="px-4 py-3 font-mono text-2xs text-ink-subtle italic">No rows.</p>
            )}
            {sample.data && sample.data.rows.length > 0 && (
              <div className="overflow-auto px-2 pb-3">
                <table className="w-full border-collapse font-mono text-2xs">
                  <thead>
                    <tr>
                      {sampleColumns.map((c) => (
                        <th
                          key={c.name}
                          className="border-b border-border-subtle px-2 py-1 text-left font-medium whitespace-nowrap text-ink-muted"
                        >
                          {c.name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sample.data.rows.map((row, ri) => (
                      <tr key={ri} className="hover:bg-surface-sunken">
                        {row.map((cell, ci) => (
                          <td
                            key={ci}
                            className={cn(
                              'border-b border-border-subtle/60 px-2 py-1 whitespace-nowrap',
                              cell === null ? 'text-ink-subtle italic' : 'text-ink-base',
                            )}
                          >
                            {cell === null ? 'null' : String(cell)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
