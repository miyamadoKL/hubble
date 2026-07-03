// StatsStrip コンポーネント
// SQL セルの実行中〜完了後に表示される、状態、進捗、件数、バイト数などの
// ライブ統計バー。SSE（Server-Sent Events）で届く QueryStats を受け取り、
// クエリの実行状況をリアルタイムに可視化する。エディタと結果ペイン（ResultPane）
// の間に配置される。
import type { QueryState, QueryStats } from '@hubble/contracts';
import { ExternalLink, Square, TriangleAlert } from 'lucide-react';
import { StateBadge } from '../common/StateBadge';
import { ProgressBar } from './ProgressBar';
import { formatBytes, formatDuration, formatInt } from '../../utils/format';
import { cn } from '../../utils/cn';

/**
 * Live stats strip + progress (design.md §5: state / progress% / splits / rows /
 * bytes / elapsed ticker, Trino Web UI link, truncated warning, cancel). Sits
 * between the editor and the result pane and updates as SSE stats arrive.
 */

/** 個々の統計項目（ラベルと値のペア）の props */
interface StatItemProps {
  // 項目名（例: "elapsed", "rows" など）
  label: string;
  // 表示する値（フォーマット済み文字列）
  value: string;
}

/** ラベルと値を横並びで表示する小さな統計項目コンポーネント。 */
function StatItem({ label, value }: StatItemProps) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-2xs tracking-wide text-ink-subtle uppercase">{label}</span>
      <span className="font-mono text-xs tabular-nums text-ink-base">{value}</span>
    </div>
  );
}

/** StatsStrip の props */
interface StatsStripProps {
  // クエリの現在の状態（queued / running / finished / failed など）
  state: QueryState;
  // Trino から届いた統計情報（経過時間、処理行数、バイト数、スプリット数など）
  stats?: QueryStats;
  // Trino Web UI へのリンク先URL（あれば「Trino UI」リンクを表示する）
  infoUri?: string;
  /** Rows materialised client-side so far (grows as SSE chunks arrive). */
  // クライアント側にここまで実体化（取得済み）した行数。SSEのチャンクが届くたびに増える。
  loadedRows?: number;
  // 結果が行数上限で打ち切られたかどうか（true なら警告バッジを表示）
  truncated?: boolean;
  /** Shown only while running/queued. */
  // 実行中またはキュー待ち中のみ表示するキャンセルボタンのハンドラー
  onCancel?: () => void;
  // 外部から追加のクラス名を渡すためのフィールド
  className?: string;
}

/**
 * ライブ統計バー本体。state / stats などから実行中かどうかを判定し、
 * 実行中ならプログレスバーとキャンセルボタンを表示、完了後は最終的な
 * 統計値（経過時間、行数、バイト数など）を並べて表示する。
 */
export function StatsStrip({
  state,
  stats,
  infoUri,
  loadedRows,
  truncated,
  onCancel,
  className,
}: StatsStripProps) {
  // state が running または queued の間は「実行中」とみなす。
  const running = state === 'running' || state === 'queued';
  // Trino が返す進捗率（0〜100）。queued 中は取得できないことが多い。
  const progress = stats?.progressPercentage;

  return (
    <div className={cn('border-y border-border-subtle bg-surface-base', className)}>
      {/* 実行中のみプログレスバーを表示。queued 中は進捗が不明なので不確定モードで描画する。 */}
      {running && <ProgressBar value={state === 'queued' ? undefined : progress} />}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 px-3 py-2">
        {/* クエリの状態バッジ（queued / running / finished / failed など）。 */}
        <StateBadge state={state} />
        {/* 進捗率が取得できていて実行中の場合のみ、数値としても表示する。 */}
        {progress !== undefined && running && (
          <StatItem label="progress" value={`${Math.round(progress)}%`} />
        )}
        {/* 経過時間。 */}
        <StatItem label="elapsed" value={formatDuration(stats?.elapsedTimeMillis ?? 0)} />
        {/* 行数。クライアントに読み込み済みの行数(loadedRows)を優先し、なければ Trino 側の処理行数を使う。 */}
        <StatItem label="rows" value={formatInt(loadedRows ?? stats?.processedRows ?? 0)} />
        {/* 処理バイト数。 */}
        <StatItem label="bytes" value={formatBytes(stats?.processedBytes ?? 0)} />
        {/* スプリット（Trinoの並列処理単位）の完了数/総数。 */}
        <StatItem
          label="splits"
          value={`${formatInt(stats?.completedSplits ?? 0)}/${formatInt(stats?.totalSplits ?? 0)}`}
        />
        {/* ピークメモリ使用量。 */}
        <StatItem label="peak mem" value={formatBytes(stats?.peakMemoryBytes ?? 0)} />

        {/* 結果が行数上限で打ち切られている場合の警告バッジ。 */}
        {truncated && (
          <span className="inline-flex items-center gap-1 rounded-sm bg-warning-soft px-1.5 py-0.5 text-2xs font-medium text-warning">
            <TriangleAlert size={11} strokeWidth={2} />
            truncated
          </span>
        )}

        <div className="ml-auto flex items-center gap-3">
          {/* 実行中かつキャンセルハンドラーがある場合のみキャンセルボタンを表示。 */}
          {running && onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex items-center gap-1 rounded-sm border border-error/40 bg-error-soft px-1.5 py-0.5 text-2xs font-medium text-error hover:border-error"
            >
              <Square size={10} strokeWidth={2.5} />
              Cancel
            </button>
          )}
          {/* Trino Web UI のクエリ詳細ページへのリンク（infoUri が存在する場合のみ）。 */}
          {infoUri && (
            <a
              href={infoUri}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-2xs font-medium text-ink-muted hover:text-accent"
            >
              Trino UI
              <ExternalLink size={12} strokeWidth={1.75} />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
