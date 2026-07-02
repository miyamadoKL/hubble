/**
 * EstimateStrip.tsx
 *
 * Query Guard 機能が算出したスキャン見積もり（行数、バイト数、推定時間）と、
 * 実行可否の判定結果（block/warning など）を表示する帯状の UI コンポーネント。
 * セルツールバーの直下に配置され、実行ボタンが実際に実行しようとしている SQL 文
 * に対する見積もりを常時表示する。
 */
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

/**
 * Per-tone token classes (no raw hex — design tokens only).
 * トーン（info / warning / error / unavailable）ごとの配色クラス。
 * 生の hex 値は使わず、必ずデザイントークン（tokens.css）由来のクラスのみを使用する。
 */
const TONE_CLASSES: Record<EstimateTone, string> = {
  info: 'border-border-subtle bg-surface-inset text-ink-muted',
  warning: 'border-warning/40 bg-warning-soft text-warning',
  error: 'border-error/50 bg-error-soft text-error',
  unavailable: 'border-border-subtle bg-surface-inset text-ink-subtle',
};

/**
 * トーンに応じたアイコンを出し分ける小さな内部コンポーネント。
 * error > warning > unavailable > (デフォルト) info の優先順で判定する。
 */
function ToneIcon({ tone }: { tone: EstimateTone }) {
  if (tone === 'error') return <OctagonX size={12} strokeWidth={2} className="shrink-0" />;
  if (tone === 'warning') return <TriangleAlert size={12} strokeWidth={2} className="shrink-0" />;
  if (tone === 'unavailable') return <CircleAlert size={12} strokeWidth={2} className="shrink-0" />;
  return <Gauge size={12} strokeWidth={2} className="shrink-0" />;
}

/** EstimateStrip コンポーネントに渡す props の型。 */
interface EstimateStripProps {
  /** 表示すべき見積もり情報一式（トーン、ラベル、行数/バイト数/推定秒数、理由、ブロック有無、表示要否など）。 */
  presentation: EstimatePresentation;
  /** True while a (debounced) estimate request is in flight. */
  /** デバウンスされた見積もりリクエストが実行中（未完了）の間 true。ローディング表示に使う。 */
  loading?: boolean;
}

/**
 * Query Guard の見積もり結果を表示する帯状コンポーネント本体。
 * `presentation.visible` が false の場合は何も描画しない。
 * トーンに応じた配色とアイコンで、行数、バイト数、推定時間、ブロック理由などをまとめて表示する。
 *
 * @param presentation - 表示する見積もり結果一式（トーン、ラベル、数値、理由、ブロック有無等）。
 * @param loading - 見積もり取得中かどうか（true の間はスピナーを表示しつつ直前の数値を保持する）。
 */
export function EstimateStrip({ presentation, loading }: EstimateStripProps) {
  // 見積もりを表示すべきでない場合（対象 SQL がない等）は何も描画しない。
  if (!presentation.visible) return null;
  const { tone, label, scanRows, scanBytes, estimatedSeconds, reasons, blocked } = presentation;

  // 表示する数値群（行数、バイト数、推定時間）を、値が存在するものだけ組み立てる。
  const figures: string[] = [];
  if (scanRows !== null) figures.push(`${formatInt(scanRows)} rows`);
  if (scanBytes !== null) figures.push(formatBytes(scanBytes));
  if (estimatedSeconds !== null)
    figures.push(`~${formatDuration(Math.round(estimatedSeconds * 1000))}`);

  // 帯本体（アイコン + ラベル + 数値 + ブロック時の理由）の共通 JSX。
  // ツールチップの有無に関わらず共通で使うため変数として組み立てておく。
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
      {/* ローディング中はスピナーを、それ以外はトーンに応じたアイコンを表示する。 */}
      {loading ? (
        <Loader2 size={12} strokeWidth={2} className="shrink-0 animate-spin" />
      ) : (
        <ToneIcon tone={tone} />
      )}
      <span className="font-semibold tracking-wide uppercase">{label}</span>
      {/* 行数、バイト数、推定時間などの数値群（存在するもののみ「・」区切りで表示）。 */}
      {figures.length > 0 && <span className="text-ink-base">{figures.join(' · ')}</span>}
      {/* Block reasons are shown inline (the run is disabled — the user needs them). */}
      {/* 実行がブロックされている場合、最初の理由文をインラインで表示する（実行不可の理由をすぐわかるように）。 */}
      {blocked && reasons.length > 0 && (
        <span className="truncate font-sans font-medium not-italic">— {reasons[0]}</span>
      )}
    </span>
  );

  // Warn/unavailable reasons (not already shown inline) hang off a tooltip.
  // ブロックされていないが警告/取得不可の理由がある場合は、ツールチップとしてまとめて表示する。
  if (!blocked && reasons.length > 0) {
    return (
      <div className="flex px-2 py-1">
        <Tooltip
          label={
            // 複数の理由文を1行ずつ並べて表示する。
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

  // 理由が特にない（またはブロック時で理由をすでにインライン表示済みの）場合は、帯だけをそのまま表示する。
  return <div className="flex px-2 py-1">{body}</div>;
}
