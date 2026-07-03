/**
 * データソース id を displayName に解決して表示するバッジ。
 */
import type { DatasourceSummary } from '@hubble/contracts';
import { resolveDatasourceLabel } from '../../hooks/useDatasources';
import { DATASOURCE_KIND_LABEL } from '../../utils/datasourceKind';
import { cn } from '../../utils/cn';

/**
 * 履歴やスケジュール一覧などで使う、データソース表示バッジ。
 */
export function DatasourceBadge({
  datasourceId,
  datasources,
  className,
}: {
  datasourceId: string | undefined | null;
  datasources: DatasourceSummary[];
  className?: string;
}) {
  if (!datasourceId) return null;
  const label = resolveDatasourceLabel(datasources, datasourceId);
  const kind = datasources.find((d) => d.id === datasourceId)?.kind;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full bg-surface-sunken px-2 py-0.5 font-mono text-2xs text-ink-muted',
        className,
      )}
      title={datasourceId}
    >
      {kind && <span className="text-ink-subtle">{DATASOURCE_KIND_LABEL[kind]}</span>}
      <span className="max-w-[8rem] truncate">{label}</span>
    </span>
  );
}