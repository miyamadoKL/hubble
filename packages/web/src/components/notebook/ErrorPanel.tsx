/**
 * ErrorPanel.tsx
 *
 * SQL セルの実行エラーを表示するパネル。通常のエラー（メッセージ、Trino のエラー種別、
 * 発生位置）を表示する ErrorPanel と、Query Guard によってクエリがブロックされた場合
 * （422 QUERY_BLOCKED）に見積もりと上限の内訳を表示する QueryBlockedPanel の2種類の
 * 表示を、エラー内容に応じて出し分ける。
 */
import type { ApiErrorDetail } from '@hubble/contracts';
import { WRITE_NOT_ALLOWED } from '@hubble/contracts';
import { CircleAlert, OctagonX } from 'lucide-react';
import { cn } from '../../utils/cn';
import { parseQueryBlocked } from '../../execution';
import { formatBytes, formatInt } from '../../utils/format';

/**
 * Execution error panel (メッセージ + trinoErrorName + 位置).
 * Rendered on an error-soft well; the same line/column is also surfaced as a
 * Monaco marker by the cell wiring.
 *
 * Query Guard (Query Guard feature): a 422 `QUERY_BLOCKED` error carries a
 * structured `{ estimate, limits }` payload in `details`. We detect it and render
 * the block reasons plus a compact estimate-vs-limit breakdown instead of the
 * raw message, so the user sees exactly why the run was refused.
 */
/**
 * クエリ実行エラーを表示するパネル本体。
 * Query Guard によるブロック（QUERY_BLOCKED）を検出した場合は、専用の
 * QueryBlockedPanel に描画を委譲する。それ以外は通常のエラーメッセージ表示を行う。
 * @param error - サーバーから返されたエラー詳細（メッセージ、Trino エラー種別、行/列位置など）。
 * @param className - 外側の要素に追加で適用する任意の CSS クラス。
 */
export function ErrorPanel({ error, className }: { error: ApiErrorDetail; className?: string }) {
  if (error.code === WRITE_NOT_ALLOWED) {
    return (
      <div
        className={cn('flex gap-3 bg-error-soft px-4 py-3', className)}
        role="alert"
        data-testid="error-panel"
        data-error-code={WRITE_NOT_ALLOWED}
      >
        <CircleAlert size={16} strokeWidth={2} className="mt-0.5 shrink-0 text-error" />
        <div className="min-w-0 flex-1">
          <span className="rounded-sm bg-error/15 px-1.5 py-0.5 font-mono text-2xs font-semibold tracking-wide text-error uppercase">
            Read-only role
          </span>
          <p className="mt-1.5 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-ink-base">
            読み取り専用ロールのため、この SQL は実行できません。書き込みが必要な場合は管理者に
            相談してください。
          </p>
        </div>
      </div>
    );
  }

  // エラーが Query Guard によるブロック（QUERY_BLOCKED）由来かどうかを判定する。
  const blocked = parseQueryBlocked(error);
  // ブロックエラーの場合は専用パネルに委譲し、通常のエラー表示は行わない。
  if (blocked) return <QueryBlockedPanel error={error} blocked={blocked} className={className} />;

  // エラー発生位置（行と列）を "line N:M" 形式の文字列に整形する。行番号が無ければ位置情報自体を表示しない。
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
        {/* Trino のエラー種別（trinoErrorName）と発生位置をバッジ的に表示する行 */}
        <div className="flex flex-wrap items-center gap-2">
          {error.trinoErrorName && (
            <span className="rounded-sm bg-error/15 px-1.5 py-0.5 font-mono text-2xs font-semibold tracking-wide text-error uppercase">
              {error.trinoErrorName}
            </span>
          )}
          {position && <span className="font-mono text-2xs text-ink-muted">{position}</span>}
        </div>
        {/* エラーメッセージ本文（改行やスペースをそのまま保持して表示） */}
        <p className="mt-1.5 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-ink-base">
          {error.message}
        </p>
      </div>
    </div>
  );
}

/** Format a scan figure against its limit: "6,001,215 rows / limit 1,000,000". */
/**
 * Query Guard の見積もり値とその上限値を1行で対比表示する内部コンポーネント。
 * 例: "6,001,215 rows / limit 1,000,000"。値が上限を超えている場合は強調表示する。
 * @param label - 行の見出しラベル（例: "scan rows"）。
 * @param value - 見積もり値（不明な場合は null）。
 * @param limit - 上限値（0 以下は「上限なし」を意味する）。
 * @param kind - 数値の単位種別。'bytes' ならバイト数フォーマット、'rows' なら整数フォーマットを使う。
 */
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
  // 見積もりが不明（null）かつ上限も設定されていない場合は、表示する情報が無いので何も描画しない。
  if (value === null && limit <= 0) return null;
  // 単位種別に応じてフォーマット関数を切り替える（バイト表示 or 整数のカンマ区切り表示）。
  const fmt = kind === 'bytes' ? formatBytes : formatInt;
  const valueText = value === null ? 'unknown' : fmt(value);
  const limitText = limit > 0 ? fmt(limit) : 'no limit';
  // 見積もり値が上限を超えているかどうか（超えていれば赤字強調する）。
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

/**
 * Query Guard によってクエリがブロックされたときに表示する専用エラーパネル。
 * ブロック理由（reasons）と、スキャン行数／バイト数の見積もり対上限の内訳を表示し、
 * ユーザーになぜ実行が拒否されたのかを具体的に示す。
 * @param error - 元のエラー詳細（フォールバックのメッセージ表示に使う）。
 * @param blocked - parseQueryBlocked が抽出した構造化データ（見積もりと上限を含む）。
 * @param className - 外側の要素に追加で適用する任意の CSS クラス。
 */
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
  // ブロック理由の一覧。verdict に理由が無ければ元のエラーメッセージをフォールバックとして使う。
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
        {/* 見出し：「Query blocked」バッジと簡潔な説明文 */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-sm bg-error/15 px-1.5 py-0.5 font-mono text-2xs font-semibold tracking-wide text-error uppercase">
            Query blocked
          </span>
          <span className="text-2xs text-ink-muted">
            scan estimate exceeds the configured limit
          </span>
        </div>

        {/* ブロック理由の一覧（Query Guard の verdict から取得、複数ありうる） */}
        <ul className="mt-1.5 space-y-0.5">
          {reasons.map((r, i) => (
            <li key={i} className="text-xs leading-relaxed break-words text-ink-base">
              {r}
            </li>
          ))}
        </ul>

        {/* スキャン行数とスキャンバイト数それぞれの見積もり対上限の内訳表示 */}
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
