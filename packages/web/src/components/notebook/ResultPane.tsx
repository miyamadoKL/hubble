import { useEffect, useState } from 'react';
import {
  BarChart3,
  Check,
  Clipboard,
  Download,
  FileText,
  Info,
  Table2,
  TriangleAlert,
} from 'lucide-react';
import { Tabs, type TabItem } from '../common/Tabs';
import { IconButton } from '../common/IconButton';
import { Button } from '../common/Button';
import { EmptyState } from '../common/EmptyState';
import { Dropdown } from '../common/Dropdown';
import { ResultGrid } from './ResultGrid';
import { ChartPanel } from './ChartPanel';
import { ErrorPanel } from './ErrorPanel';
import { formatBytes, formatDuration, formatInt } from '../../utils/format';
import { cn } from '../../utils/cn';
import {
  copyResultToClipboard,
  downloadCsvUrl,
  isCellRunning,
  type CellExecution,
  type DownloadFormat,
} from '../../execution';

/**
 * Live result pane with per-cell tabs (design.md §6: Grid / Chart / Explain /
 * Details + Error). Driven entirely by the cell's `CellExecution` record from
 * the execution store. EXPLAIN runs a separate query through `onExplain` and
 * shows its plan text here.
 */

type ResultTab = 'grid' | 'chart' | 'explain' | 'details';

interface ResultPaneProps {
  /** The notebook cell id (keys the per-cell chart config). */
  cellId: string;
  cell: CellExecution;
  /** Plain plan text from an EXPLAIN run (single-column rows joined by newline). */
  explainText?: string;
  explainRunning?: boolean;
  onExplain?: () => void;
}

interface DetailRowProps {
  label: string;
  value: string;
  mono?: boolean;
}

function DetailRow({ label, value, mono = true }: DetailRowProps) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border-subtle py-1.5">
      <span className="text-xs text-ink-muted">{label}</span>
      <span className={cn('text-xs text-ink-base', mono && 'font-mono tabular-nums')}>{value}</span>
    </div>
  );
}

export function ResultPane({ cellId, cell, explainText, explainRunning, onExplain }: ResultPaneProps) {
  const [tab, setTab] = useState<ResultTab>('grid');
  const [copied, setCopied] = useState(false);
  const hasError = Boolean(cell.error);

  const TABS: TabItem<ResultTab>[] = [
    { id: 'grid', label: 'Grid', icon: Table2 },
    { id: 'chart', label: 'Chart', icon: BarChart3 },
    { id: 'explain', label: 'Explain', icon: FileText },
    { id: 'details', label: 'Details', icon: Info },
  ];

  // Trigger the EXPLAIN run the first time its tab is opened (or re-run via btn).
  useEffect(() => {
    if (tab === 'explain' && explainText === undefined && !explainRunning) {
      onExplain?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const onCopy = async () => {
    try {
      await copyResultToClipboard(cell.columns, cell.rows);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard denied — no-op */
    }
  };

  const stats = cell.stats;
  const running = isCellRunning(cell);

  return (
    <div className="animate-[slideUp_150ms_ease-out]" data-testid="result-pane">
      {/* Error banner takes priority above the tabs. */}
      {hasError && cell.error && <ErrorPanel error={cell.error} />}

      <div className="flex items-center justify-between gap-2 pr-2">
        <Tabs items={TABS} value={tab} onChange={setTab} className="flex-1" />
        <div className="flex items-center gap-0.5">
          <IconButton
            icon={copied ? Check : Clipboard}
            label={copied ? 'Copied' : 'Copy as TSV + HTML'}
            size="sm"
            disabled={cell.rows.length === 0}
            onClick={onCopy}
          />
          <CsvDownload queryId={cell.queryId} disabled={!cell.queryId} />
        </div>
      </div>

      {tab === 'grid' &&
        (cell.columns.length === 0 && !running ? (
          <div className="bg-surface-sunken">
            <EmptyState
              icon={Table2}
              title={hasError ? 'No result' : 'No rows'}
              description={
                hasError
                  ? 'The statement failed — see the error above.'
                  : 'This statement returned no rows.'
              }
              compact
            />
          </div>
        ) : (
          <>
            <ResultGrid columns={cell.columns} rows={cell.rows} />
            <div className="flex items-center justify-between border-t border-border-base bg-surface-base px-3 py-1.5">
              <span className="font-mono text-2xs text-ink-subtle">
                {formatInt(cell.rowCount)} rows · {cell.columns.length} columns
              </span>
              {cell.truncated && (
                <span className="inline-flex items-center gap-1 text-2xs font-medium text-warning">
                  <TriangleAlert size={11} strokeWidth={2} />
                  result truncated at the row cap
                </span>
              )}
            </div>
          </>
        ))}

      {tab === 'chart' && <ChartPanel cellId={cellId} columns={cell.columns} rows={cell.rows} />}

      {tab === 'explain' && (
        <ExplainView text={explainText} running={explainRunning} onRun={onExplain} />
      )}

      {tab === 'details' && (
        <div className="bg-surface-sunken px-4 py-2">
          <DetailRow label="Query id" value={cell.queryId || '—'} />
          <DetailRow label="Trino query id" value={cell.trinoQueryId ?? '—'} />
          <DetailRow
            label="Submitted"
            value={cell.startedAt ? new Date(cell.startedAt).toLocaleString() : '—'}
            mono={false}
          />
          <DetailRow
            label="Finished"
            value={cell.finishedAt ? new Date(cell.finishedAt).toLocaleString() : '—'}
            mono={false}
          />
          <DetailRow label="State" value={cell.state} mono={false} />
          <DetailRow label="Elapsed" value={formatDuration(stats?.elapsedTimeMillis ?? 0)} />
          <DetailRow label="Wall time" value={formatDuration(stats?.wallTimeMillis ?? 0)} />
          <DetailRow label="Processed rows" value={formatInt(stats?.processedRows ?? 0)} />
          <DetailRow label="Processed bytes" value={formatBytes(stats?.processedBytes ?? 0)} />
          <DetailRow label="Peak memory" value={formatBytes(stats?.peakMemoryBytes ?? 0)} />
          <DetailRow
            label="Splits"
            value={`${formatInt(stats?.completedSplits ?? 0)} / ${formatInt(stats?.totalSplits ?? 0)}`}
          />
          <DetailRow label="Worker nodes" value={stats?.nodes ? formatInt(stats.nodes) : '—'} />
        </div>
      )}
    </div>
  );
}

function ExplainView({
  text,
  running,
  onRun,
}: {
  text?: string;
  running?: boolean;
  onRun?: () => void;
}) {
  if (running) {
    return (
      <div className="bg-surface-sunken px-4 py-6 text-center font-mono text-xs text-ink-muted">
        Running EXPLAIN…
      </div>
    );
  }
  if (text === undefined) {
    return (
      <div className="bg-surface-sunken">
        <EmptyState
          icon={FileText}
          title="Explain plan"
          description="Run EXPLAIN on the current statement to see its distributed plan."
          compact
          action={
            onRun ? (
              <Button size="sm" icon={FileText} onClick={onRun}>
                Run EXPLAIN
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  }
  return (
    <pre className="max-h-96 overflow-auto bg-surface-sunken px-4 py-3 font-mono text-xs leading-relaxed text-ink-base">
      {text || '(empty plan)'}
    </pre>
  );
}

/** CSV download as plain `a[href]` so the server streams it (no buffering). */
function CsvDownload({ queryId, disabled }: { queryId: string; disabled: boolean }) {
  const [format, setFormat] = useState<DownloadFormat>('zip');
  const href = disabled ? undefined : downloadCsvUrl(queryId, format);
  const ext = format === 'zip' ? 'zip' : 'csv';
  return (
    <div className="flex items-center">
      <a
        href={href}
        download={disabled ? undefined : `result-${queryId}.${ext}`}
        aria-disabled={disabled}
        className={cn(
          'inline-flex h-6 items-center gap-1 rounded-l-md border border-border-base px-2 text-2xs font-medium',
          disabled
            ? 'pointer-events-none text-ink-subtle opacity-40'
            : 'text-ink-muted hover:bg-surface-sunken hover:text-ink-strong',
        )}
      >
        <Download size={13} strokeWidth={1.75} />
        {format === 'zip' ? 'CSV (zip)' : 'CSV'}
      </a>
      <Dropdown<DownloadFormat>
        value={format}
        onChange={setFormat}
        options={[
          { value: 'zip', label: 'Zipped .zip' },
          { value: 'csv', label: 'Plain .csv' },
        ]}
        ariaLabel="Download format"
        align="end"
        className="h-6 rounded-l-none rounded-r-md border-l-0 text-2xs"
        bare
      />
    </div>
  );
}
