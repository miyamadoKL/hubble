/**
 * LastRunStrip.tsx
 *
 * SQL セルの「最終実行結果」の要約を表示する帯（ストリップ）コンポーネント。
 * ノートブックを再読み込みした直後など、実行結果の行データ自体は永続化されていないが
 * 実行サマリー（成功/失敗、行数、所要時間、実行日時など）だけは保存されている場合に、
 * ユーザーが再実行するまでの「空状態の代わり」として表示される。
 */
import { CircleCheck, CircleX, History, Play } from 'lucide-react';
import type { CellResultMeta } from '@hubble/contracts';
import { formatDuration, formatInt, formatRelativeTime } from '../../utils/format';
import { cn } from '../../utils/cn';

/**
 * "Last run" strip (design.md §4 resultMeta). Shown on a reloaded SQL cell that
 * has a persisted execution summary but no live result yet — full result rows
 * are never persisted, so this is the empty-state stand-in until the user re-runs.
 */
/**
 * セルの最終実行サマリー（meta）を表示する帯コンポーネント。
 *
 * @param meta - 永続化された実行結果のメタ情報（状態、行数、所要時間、実行日時、エラー内容など）。
 * @param onRun - 「Re-run」ボタン押下時のコールバック。未指定の場合はボタン自体を表示しない。
 */
export function LastRunStrip({ meta, onRun }: { meta: CellResultMeta; onRun?: () => void }) {
  // 実行が失敗状態だったかどうか。表示アイコンや配色の分岐に使う。
  const failed = meta.state === 'failed';
  // 失敗時は×アイコン、それ以外（成功）は✓アイコンを使う。
  const Icon = failed ? CircleX : CircleCheck;
  // 実行日時を「〜前」形式の相対時刻テキストに変換する（実行日時が無ければ null）。
  const when = meta.executedAt ? formatRelativeTime(meta.executedAt) : null;

  return (
    <div
      data-testid="last-run-strip"
      className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border-subtle bg-surface-sunken px-3 py-2"
    >
      {/* 「Last run」ラベル（履歴アイコン付き）。 */}
      <span className="inline-flex items-center gap-1.5 text-2xs font-semibold tracking-wide text-ink-muted uppercase">
        <History size={12} strokeWidth={2} />
        Last run
      </span>
      {/* 実行結果の状態バッジ。失敗時は赤系、それ以外は緑系の配色にする。 */}
      <span
        className={cn(
          'inline-flex items-center gap-1 text-xs font-medium',
          failed ? 'text-error' : 'text-success',
        )}
      >
        <Icon size={13} strokeWidth={2} />
        {meta.state ?? 'finished'}
      </span>
      {/* 失敗していない場合のみ、取得した行数を表示する（rowCount が存在するとき）。 */}
      {!failed && meta.rowCount !== undefined && (
        <span className="font-mono text-2xs text-ink-muted tabular-nums">
          {formatInt(meta.rowCount)} rows
        </span>
      )}
      {/* 実行にかかった所要時間（elapsedMs が存在するとき）。 */}
      {meta.elapsedMs !== undefined && (
        <span className="font-mono text-2xs text-ink-muted tabular-nums">
          {formatDuration(meta.elapsedMs)}
        </span>
      )}
      {/* 失敗時かつエラーメッセージがある場合のみ、省略表示のエラーメッセージを出す（title でホバー時に全文表示）。 */}
      {failed && meta.errorMessage && (
        <span className="min-w-0 flex-1 truncate font-mono text-2xs text-error" title={meta.errorMessage}>
          {meta.errorMessage}
        </span>
      )}
      {/* 右端に寄せる領域: 相対実行時刻の表示と、再実行ボタン（onRun が渡されている場合のみ）。 */}
      <div className="ml-auto flex items-center gap-3">
        {when && <span className="font-mono text-2xs text-ink-subtle">{when}</span>}
        {onRun && (
          <button
            type="button"
            onClick={onRun}
            className="inline-flex items-center gap-1 rounded-sm border border-border-base bg-surface-raised px-1.5 py-0.5 text-2xs font-medium text-ink-muted hover:border-accent/40 hover:text-accent"
          >
            <Play size={10} strokeWidth={2.5} />
            Re-run
          </button>
        )}
      </div>
    </div>
  );
}
