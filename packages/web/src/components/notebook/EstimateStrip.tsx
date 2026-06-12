import { CircleAlert, Gauge, Loader2, OctagonX, TriangleAlert } from 'lucide-react';
import { Tooltip } from '../common/Tooltip';
import { formatBytes, formatDuration, formatInt } from '../../utils/format';
import { cn } from '../../utils/cn';
import type { EstimatePresentation, EstimateTone } from '../../execution/estimate';

/**
 * Query Guard live-estimate strip (Query Guard feature). A compact, instrument-
 * grade badge that sits just under the cell toolbar and surfaces the scan-cost
 * estimate + guard verdict for the statement the run button would execute:
 *
 *   ⏱  ESTIMATED SCAN  6,001,215 rows · 747.7 MB · ~7.8 s   [block reasons →]
 *
 * Tone (info / warning / error / unavailable) is driven entirely by design
 * tokens (tokens.css); warn/block reasons hang off a tooltip and, for a block,
 * are shown inline so the user sees why the run is disabled. Loading is a quiet,
 * non-flickering spinner that keeps the prior figures (placeholderData).
 */

/** Per-tone token classes (no raw hex — design tokens only). */
const TONE_CLASSES: Record<EstimateTone, string> = {
  info: 'border-border-subtle bg-surface-inset text-ink-muted',
  warning: 'border-warning/40 bg-warning-soft text-warning',
  error: 'border-error/50 bg-error-soft text-error',
  unavailable: 'border-border-subtle bg-surface-inset text-ink-subtle',
};

function ToneIcon({ tone }: { tone: EstimateTone }) {
  if (tone === 'error') return <OctagonX size={12} strokeWidth={2} className="shrink-0" />;
  if (tone === 'warning') return <TriangleAlert size={12} strokeWidth={2} className="shrink-0" />;
  if (tone === 'unavailable') return <CircleAlert size={12} strokeWidth={2} className="shrink-0" />;
  return <Gauge size={12} strokeWidth={2} className="shrink-0" />;
}

interface EstimateStripProps {
  presentation: EstimatePresentation;
  /** True while a (debounced) estimate request is in flight. */
  loading?: boolean;
}

export function EstimateStrip({ presentation, loading }: EstimateStripProps) {
  if (!presentation.visible) return null;
  const { tone, label, scanRows, scanBytes, estimatedSeconds, reasons, blocked } = presentation;

  const figures: string[] = [];
  if (scanRows !== null) figures.push(`${formatInt(scanRows)} rows`);
  if (scanBytes !== null) figures.push(formatBytes(scanBytes));
  if (estimatedSeconds !== null)
    figures.push(`~${formatDuration(Math.round(estimatedSeconds * 1000))}`);

  const body = (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-sm border px-1.5 py-0.5',
        'font-mono text-2xs tabular-nums',
        TONE_CLASSES[tone],
      )}
      data-testid="estimate-strip"
      data-tone={tone}
      data-blocked={blocked ? 'true' : 'false'}
    >
      {loading ? (
        <Loader2 size={12} strokeWidth={2} className="shrink-0 animate-spin" />
      ) : (
        <ToneIcon tone={tone} />
      )}
      <span className="font-semibold tracking-wide uppercase">{label}</span>
      {figures.length > 0 && <span className="text-ink-base">{figures.join(' · ')}</span>}
      {/* Block reasons are shown inline (the run is disabled — the user needs them). */}
      {blocked && reasons.length > 0 && (
        <span className="truncate font-sans font-medium not-italic">— {reasons[0]}</span>
      )}
    </span>
  );

  // Warn/unavailable reasons (not already shown inline) hang off a tooltip.
  if (!blocked && reasons.length > 0) {
    return (
      <div className="flex px-2 py-1">
        <Tooltip
          label={
            <span className="block max-w-xs whitespace-normal text-left">
              {reasons.map((r, i) => (
                <span key={i} className="block">
                  {r}
                </span>
              ))}
            </span>
          }
        >
          {body}
        </Tooltip>
      </div>
    );
  }

  return <div className="flex px-2 py-1">{body}</div>;
}
