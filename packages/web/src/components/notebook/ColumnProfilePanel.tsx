/**
 * ColumnProfilePanel.tsx
 *
 * 結果グリッドのツールバーから開く列プロファイルのドロップダウンパネル。
 * `GET /api/queries/:id/profile` で取得した null 数、distinct 概算、min/max、
 * 頻出値を列ごとに表示する。集計はサーバー側で行われるため、クライアントに
 * 全行が載っていない結果でも全行分のプロファイルが見られる。
 */
import { useEffect, useState } from 'react';
import type { ResultColumnProfile, ResultProfile } from '@hubble/contracts';
import { fetchQueryProfile } from '../../execution/api';
import { formatInt } from '../../utils/format';
import { cn } from '../../utils/cn';

/** ColumnProfilePanel の props。 */
interface ColumnProfilePanelProps {
  /** 対象クエリ id。 */
  queryId: string;
  /** パネルを閉じるコールバック（背景クリック時に呼ばれる）。 */
  onClose: () => void;
}

/**
 * 列プロファイルのドロップダウンパネル。マウント時にプロファイルを取得し、
 * 列ごとのカードで統計を表示する。背景クリックで閉じる。
 *
 * @param props - 対象クエリ id と close コールバック。
 */
export function ColumnProfilePanel({ queryId, onClose }: ColumnProfilePanelProps) {
  const [profile, setProfile] = useState<ResultProfile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchQueryProfile(queryId)
      .then((result) => {
        if (!cancelled) setProfile(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [queryId]);

  return (
    <>
      {/* 画面全体を覆う透明な背景。クリックでパネルを閉じる（click-away）。 */}
      <div className="fixed inset-0 z-30" onClick={onClose} aria-hidden />
      <div
        className="absolute top-7 left-0 z-40 max-h-96 w-80 overflow-auto rounded-md border border-border-base bg-surface-overlay p-2 shadow-lg"
        data-testid="column-profile-panel"
      >
        {error !== null && <p className="px-1 py-2 text-2xs text-danger">{error}</p>}
        {error === null && profile === null && (
          <p className="px-1 py-2 text-2xs text-ink-subtle">Profiling result…</p>
        )}
        {profile !== null && (
          <>
            <p className="px-1 pb-1.5 font-mono text-2xs text-ink-subtle">
              {formatInt(profile.rowCount)} rows profiled
              {/* 実行中でまだ行が増えうる場合はその旨を注記する。 */}
              {!profile.complete && ' (still running)'}
            </p>
            {profile.columns.map((column, i) => (
              <ColumnCard key={i} column={column} rowCount={profile.rowCount} />
            ))}
          </>
        )}
      </div>
    </>
  );
}

/** 1 列分のプロファイルカード。 */
function ColumnCard({ column, rowCount }: { column: ResultColumnProfile; rowCount: number }) {
  // null 率（%）。0 行のときは 0 とする。
  const nullPct = rowCount === 0 ? 0 : (column.nullCount / rowCount) * 100;
  return (
    <div className="mb-1.5 rounded-sm border border-border-subtle bg-surface-raised px-2 py-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-xs font-semibold text-ink-base">{column.name}</span>
        <span className="shrink-0 font-mono text-[0.625rem] text-ink-subtle">{column.type}</span>
      </div>
      <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5">
        <ProfileStat
          label="nulls"
          value={`${formatInt(column.nullCount)} (${nullPct.toFixed(1)}%)`}
          emphasize={column.nullCount > 0}
        />
        <ProfileStat
          label="distinct"
          // overflow 時は追跡上限までの下限値であることを ≥ で示す。
          value={`${column.distinctOverflow ? '≥ ' : ''}${formatInt(column.distinctCount)}`}
        />
        {column.min !== undefined && <ProfileStat label="min" value={column.min} mono />}
        {column.max !== undefined && <ProfileStat label="max" value={column.max} mono />}
      </dl>
      {column.topValues.length > 0 && (
        <div className="mt-1 border-t border-border-subtle pt-1">
          {column.topValues.map((top, i) => (
            <div key={i} className="flex items-center justify-between gap-2">
              <span className="truncate font-mono text-2xs text-ink-muted" title={top.value}>
                {top.value}
              </span>
              <span className="shrink-0 font-mono text-2xs text-ink-subtle tabular-nums">
                {formatInt(top.count)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** プロファイルの 1 統計値（ラベルと値のペア）。 */
function ProfileStat({
  label,
  value,
  mono = false,
  emphasize = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  emphasize?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2 overflow-hidden">
      <dt className="text-2xs text-ink-subtle">{label}</dt>
      <dd
        className={cn(
          'truncate text-2xs',
          mono && 'font-mono tabular-nums',
          emphasize ? 'text-warning' : 'text-ink-base',
        )}
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}
