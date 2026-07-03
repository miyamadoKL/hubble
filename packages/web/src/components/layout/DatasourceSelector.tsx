/**
 * TopBar 用のデータソースセレクタ。
 *
 * 一覧の displayName と kind バッジを表示し、選択は datasourceStore へ反映する。
 * データソースが 1 件だけでも常に表示する。
 */
import type { DatasourceSummary } from '@hubble/contracts';
import { Server } from 'lucide-react';
import { Dropdown } from '../common/Dropdown';
import { Spinner } from '../common/Spinner';
import { DATASOURCE_KIND_LABEL } from '../../utils/datasourceKind';
import { cn } from '../../utils/cn';

/**
 * データソース選択ドロップダウン。
 */
export function DatasourceSelector({
  datasources,
  selectedId,
  onChange,
  loading,
}: {
  datasources: DatasourceSummary[];
  selectedId: string | undefined;
  onChange: (id: string) => void;
  loading?: boolean;
}) {
  if (loading) {
    return (
      <div className="flex h-8 items-center gap-1.5 rounded-md border border-border-base bg-surface-raised px-2.5">
        <Spinner size={12} />
        <span className="font-mono text-2xs text-ink-subtle">Datasources</span>
      </div>
    );
  }

  const selected = datasources.find((d) => d.id === selectedId) ?? datasources[0];
  if (!selected) return null;

  return (
    <Dropdown
      value={selected.id}
      options={datasources.map((d) => ({
        value: d.id,
        label: d.displayName,
        hint: DATASOURCE_KIND_LABEL[d.kind],
      }))}
      onChange={onChange}
      ariaLabel="Data source"
      className="w-44"
      leading={
        <>
          <Server size={14} strokeWidth={1.75} className="shrink-0 text-ink-subtle" />
          {selected && <KindBadge kind={selected.kind} className="shrink-0" />}
        </>
      }
    />
  );
}

/** kind を示す小さなバッジ。 */
function KindBadge({ kind, className }: { kind: DatasourceSummary['kind']; className?: string }) {
  return (
    <span
      className={cn(
        'rounded px-1 py-px font-mono text-2xs font-medium uppercase tracking-wide',
        kind === 'trino' && 'bg-accent-soft text-accent',
        kind === 'mysql' && 'bg-running-soft text-running',
        kind === 'postgresql' && 'bg-surface-sunken text-ink-muted',
        className,
      )}
    >
      {DATASOURCE_KIND_LABEL[kind]}
    </span>
  );
}
