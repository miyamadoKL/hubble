import type { ApiErrorDetail } from '@hubble/contracts';
import { CircleAlert, OctagonX } from 'lucide-react';
import { cn } from '../../utils/cn';
import { parseQueryBlocked } from '../../execution';
import { formatBytes, formatInt } from '../../utils/format';

/**
 * Execution error panel (design.md §5: メッセージ + trinoErrorName + 位置).
 * Rendered on an error-soft well; the same line/column is also surfaced as a
 * Monaco marker by the cell wiring.
 *
 * Query Guard (Query Guard feature): a 422 `QUERY_BLOCKED` error carries a
 * structured `{ estimate, limits }` payload in `details`. We detect it and render
 * the block reasons plus a compact estimate-vs-limit breakdown instead of the
 * raw message, so the user sees exactly why the run was refused.
 */
export function ErrorPanel({ error, className }: { error: ApiErrorDetail; className?: string }) {
  const blocked = parseQueryBlocked(error);
  if (blocked) return <QueryBlockedPanel error={error} blocked={blocked} className={className} />;

  const position =
    error.line !== undefined
      ? `line ${error.line}${error.column !== undefined ? `:${error.column}` : ''}`
      : undefined;
  return (
    <div
      className={cn('flex gap-3 bg-error-soft px-4 py-3', className)}
      role="alert"
      data-testid="error-panel"
    >
      <CircleAlert size={16} strokeWidth={2} className="mt-0.5 shrink-0 text-error" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          {error.trinoErrorName && (
            <span className="rounded-sm bg-error/15 px-1.5 py-0.5 font-mono text-2xs font-semibold tracking-wide text-error uppercase">
              {error.trinoErrorName}
            </span>
          )}
          {position && <span className="font-mono text-2xs text-ink-muted">{position}</span>}
        </div>
        <p className="mt-1.5 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-ink-base">
          {error.message}
        </p>
      </div>
    </div>
  );
}

/** Format a scan figure against its limit: "6,001,215 rows / limit 1,000,000". */
function ScanRow({
  label,
  value,
  limit,
  kind,
}: {
  label: string;
  value: number | null;
  limit: number;
  kind: 'rows' | 'bytes';
}) {
  // 0 means "no limit"; null means "unknown estimate".
  if (value === null && limit <= 0) return null;
  const fmt = kind === 'bytes' ? formatBytes : formatInt;
  const valueText = value === null ? 'unknown' : fmt(value);
  const limitText = limit > 0 ? fmt(limit) : 'no limit';
  const over = value !== null && limit > 0 && value > limit;
  return (
    <div className="flex items-center justify-between gap-4 py-0.5">
      <span className="text-2xs tracking-wide text-ink-muted uppercase">{label}</span>
      <span className="font-mono text-xs tabular-nums text-ink-base">
        <span className={cn(over && 'font-semibold text-error')}>{valueText}</span>
        <span className="text-ink-subtle"> / limit {limitText}</span>
      </span>
    </div>
  );
}

function QueryBlockedPanel({
  error,
  blocked,
  className,
}: {
  error: ApiErrorDetail;
  blocked: NonNullable<ReturnType<typeof parseQueryBlocked>>;
  className?: string;
}) {
  const { estimate, limits } = blocked;
  const reasons = estimate.verdict.reasons.length > 0 ? estimate.verdict.reasons : [error.message];
  return (
    <div
      className={cn('flex gap-3 bg-error-soft px-4 py-3', className)}
      role="alert"
      data-testid="error-panel"
      data-error-code="QUERY_BLOCKED"
    >
      <OctagonX size={16} strokeWidth={2} className="mt-0.5 shrink-0 text-error" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-sm bg-error/15 px-1.5 py-0.5 font-mono text-2xs font-semibold tracking-wide text-error uppercase">
            Query blocked
          </span>
          <span className="text-2xs text-ink-muted">
            scan estimate exceeds the configured limit
          </span>
        </div>

        <ul className="mt-1.5 space-y-0.5">
          {reasons.map((r, i) => (
            <li key={i} className="text-xs leading-relaxed break-words text-ink-base">
              {r}
            </li>
          ))}
        </ul>

        <div className="mt-2 rounded-sm border border-error/20 bg-surface-raised/40 px-2.5 py-1.5">
          <ScanRow
            label="scan rows"
            value={estimate.scanRows}
            limit={limits.maxScanRows}
            kind="rows"
          />
          <ScanRow
            label="scan bytes"
            value={estimate.scanBytes}
            limit={limits.maxScanBytes}
            kind="bytes"
          />
        </div>
      </div>
    </div>
  );
}
