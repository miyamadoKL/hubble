/**
 * クエリの実行状態 (QueryState) を色分けされたバッジ（ピル型ラベル）として
 * 表示するコンポーネント。履歴一覧や統計ストリップなど、状態を一目で
 * 判別させたい箇所で使用される。
 */
import type { QueryState } from '@hubble/contracts';
import { cn } from '../../utils/cn';

/**
 * Semantic state pill (running=blue / success=green / error=red,
 * each with its -soft background). Used by history rows and the stats strip.
 *
 * QueryState を意味づけされた色（running=青 / success=緑 / error=赤、
 * それぞれ -soft の淡い背景色を伴う）のピルとして表示する。
 * 履歴の各行や統計ストリップから利用される。
 */

// バッジの見た目を決める色調（トーン）の種類
type Tone = 'running' | 'success' | 'error' | 'neutral';

// QueryState の各値をどのトーンにマッピングするか定義
const STATE_TONE: Record<QueryState, Tone> = {
  queued: 'neutral',
  running: 'running',
  finished: 'success',
  failed: 'error',
  canceled: 'neutral',
};

// QueryState の各値に対応する表示ラベル文字列（大文字表記）
const STATE_LABEL: Record<QueryState, string> = {
  queued: 'QUEUED',
  running: 'RUNNING',
  finished: 'FINISHED',
  failed: 'FAILED',
  canceled: 'CANCELED',
};

// トーンごとの背景色と文字色のクラス
const toneClasses: Record<Tone, string> = {
  running: 'bg-running-soft text-running',
  success: 'bg-success-soft text-success',
  error: 'bg-error-soft text-error',
  neutral: 'bg-surface-inset text-ink-muted',
};

// トーンごとの先頭ドットの背景色クラス
const dotClasses: Record<Tone, string> = {
  running: 'bg-running',
  success: 'bg-success',
  error: 'bg-error',
  neutral: 'bg-ink-subtle',
};

/**
 * StateBadge コンポーネントの props。
 */
interface StateBadgeProps {
  /** バッジに表示するクエリの実行状態。 */
  state: QueryState;
  /** 追加で付与する className。 */
  className?: string;
  /** Show a leading status dot (pulsing when running). */
  /** 先頭にステータスドットを表示するかどうか（running 時はパルスアニメーション）。 */
  dot?: boolean;
}

/**
 * QueryState に応じたトーンとラベルでバッジを描画するコンポーネント。
 *
 * @param state - 表示する実行状態。
 * @param className - 追加のクラス名。
 * @param dot - 先頭にステータスドットを表示するか（デフォルト true）。
 */
export function StateBadge({ state, className, dot = true }: StateBadgeProps) {
  // state からこのバッジで使う色調（トーン）を決定する
  const tone = STATE_TONE[state];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5',
        'font-mono text-2xs font-medium tracking-wide uppercase',
        toneClasses[tone],
        className,
      )}
    >
      {/* dot が true の場合のみ、状態を示す小さな丸を先頭に表示する（running 時は明滅） */}
      {dot && (
        <span
          className={cn(
            'h-1.5 w-1.5 shrink-0 rounded-full',
            dotClasses[tone],
            tone === 'running' && 'animate-pulse',
          )}
        />
      )}
      {STATE_LABEL[state]}
    </span>
  );
}
