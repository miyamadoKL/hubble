// StatsStrip コンポーネント
// SQL セルの実行中〜完了後に表示される、状態、進捗、件数、バイト数などの
// ライブ統計バー。SSE（Server-Sent Events）で届く QueryStats を受け取り、
// クエリの実行状況をリアルタイムに可視化する。エディタと結果ペイン（ResultPane）
// の間に配置される。
import type { QueryState, QueryStats } from '@hubble/contracts';
import { ExternalLink, Square, TriangleAlert } from 'lucide-react';
import { StatusBadge, type StatusBadgeTone } from '../common/StatusBadge';
import { ProgressBar } from './ProgressBar';
import { formatBytes, formatDuration, formatInt } from '../../utils/format';
import { cn } from '../../utils/cn';
import { useT } from '../../i18n/t';
import { useLocale } from '../../i18n/locale';
import { commonMessages } from '../../i18n/messages/common';
import { notebookMessages, queryStateLabel } from '../../i18n/messages/notebook';

/** StatsStrip 内で使う辞書の合成。共通文言（Cancel 等）+ notebook 固有文言。 */
const statsStripDict = { ...commonMessages, ...notebookMessages } as const;

// QueryState ごとの表示トーン。`components/common/StateBadge.tsx` の STATE_TONE と
// 対応関係は同じだが、ラベルをロケールに応じて翻訳する必要があるため
// StateBadge（ラベルが固定の英語のみ）は使わず、StatusBadge を直接使ってこのファイル内で
// トーンとラベルを組み立てる（`AlertStateBadge.tsx` が alertFormat.ts のロジックを
// 使いつつ StatusBadge を直接使う先例と同じ設計）。
const QUERY_STATE_TONE: Record<QueryState, StatusBadgeTone> = {
  queued: 'neutral',
  running: 'running',
  finished: 'success',
  failed: 'error',
  canceled: 'neutral',
};

/**
 * ライブ統計バー + プログレスバー本体（状態/進捗%/スプリット/行数/バイト数/経過時間、
 * Trino Web UI へのリンク、打ち切り警告、キャンセル）。エディタと結果ペインの間に
 * 配置され、SSE で届く統計情報のたびに更新される。
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
  // クライアント側にここまで実体化（取得済み）した行数。SSEのチャンクが届くたびに増える。
  loadedRows?: number;
  // 結果が行数上限で打ち切られたかどうか（true なら警告バッジを表示）
  truncated?: boolean;
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
  const t = useT(statsStripDict);
  const { locale } = useLocale();
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
        {/* StatusBadge は視覚的に uppercase 表示になる（CSS の text-transform）が、
            DOM の textContent 自体も大文字にしておく。既存 e2e スイート（editor.spec.ts /
            execution.spec.ts / notebook.spec.ts / panels.spec.ts / capture.spec.ts /
            helpers.ts の expectFinished 等、この notebook バッチの担当外の多数の
            spec）が `getByText('FINISHED', { exact: true })` のように英語ロケールでの
            大文字の生テキストへ厳密一致で依存しているため、旧 StateBadge の
            STATE_LABEL（'FINISHED' 等の定数）と bytes 単位で同じ表示になるよう
            toUpperCase() を通す（日本語文字列には影響しない no-op）。 */}
        <StatusBadge
          tone={QUERY_STATE_TONE[state]}
          label={queryStateLabel(state, locale).toUpperCase()}
        />
        {/* 進捗率が取得できていて実行中の場合のみ、数値としても表示する。 */}
        {progress !== undefined && running && (
          <StatItem label={t('statProgress')} value={`${Math.round(progress)}%`} />
        )}
        {/* 経過時間。 */}
        <StatItem label={t('elapsedLabel')} value={formatDuration(stats?.elapsedTimeMillis ?? 0)} />
        {/* 行数。クライアントに読み込み済みの行数(loadedRows)を優先し、なければ Trino 側の処理行数を使う。 */}
        <StatItem
          label={t('rowsLabel')}
          value={formatInt(loadedRows ?? stats?.processedRows ?? 0)}
        />
        {/* 処理バイト数。 */}
        <StatItem label={t('statBytes')} value={formatBytes(stats?.processedBytes ?? 0)} />
        {/* スプリット（Trinoの並列処理単位）の完了数/総数。 */}
        <StatItem
          label={t('statSplits')}
          value={`${formatInt(stats?.completedSplits ?? 0)}/${formatInt(stats?.totalSplits ?? 0)}`}
        />
        {/* ピークメモリ使用量。 */}
        <StatItem label={t('statPeakMem')} value={formatBytes(stats?.peakMemoryBytes ?? 0)} />

        {/* 結果が行数上限で打ち切られている場合の警告バッジ。 */}
        {truncated && (
          <span className="inline-flex items-center gap-1 rounded-sm bg-warning-soft px-1.5 py-0.5 text-2xs font-medium text-warning">
            <TriangleAlert size={11} strokeWidth={2} />
            {t('truncatedBadge')}
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
              {t('cancel')}
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
              {t('trinoUiLink')}
              <ExternalLink size={12} strokeWidth={1.75} />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
