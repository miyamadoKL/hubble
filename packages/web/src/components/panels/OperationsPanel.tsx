/**
 * Operations パネル: 全ユーザーの実行中クエリ一覧と kill 操作。
 */
import { useState } from 'react';
import type { AdminQueryItem } from '@hubble/contracts';
import { Activity, OctagonX } from 'lucide-react';
import { EmptyState } from '../common/EmptyState';
import { Spinner } from '../common/Spinner';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { toast } from '../common/Toast';
import { QueryStateBadge } from './QueryStateBadge';
import { DatasourceBadge } from '../common/DatasourceBadge';
import { useAdminQueries, useKillAdminQuery } from '../../hooks/useAdminQueries';
import { useMe } from '../../hooks/useMe';
import { hasPermission } from '../../permissions';
import { useDatasources } from '../../hooks/useDatasources';
import { formatDuration } from '../../utils/format';
import { cn } from '../../utils/cn';
import { useT } from '../../i18n/t';
import { commonMessages } from '../../i18n/messages/common';
import { panelsMessages } from '../../i18n/messages/panels';

/** OperationsPanel 内で使う辞書の合成。共通文言 + パネル固有文言を 1 つの t() で引けるようにする。 */
const operationsDict = { ...commonMessages, ...panelsMessages } as const;

function OperationsRow({
  item,
  datasources,
  canKill,
  onKill,
  killing,
}: {
  item: AdminQueryItem;
  datasources: ReturnType<typeof useDatasources>['datasources'];
  canKill: boolean;
  onKill: (item: AdminQueryItem) => void;
  killing: boolean;
}) {
  const t = useT(operationsDict);
  const oneLine = item.statement.replace(/\s+/g, ' ').trim();
  const progress =
    item.stats?.progressPercentage !== undefined
      ? `${Math.round(item.stats.progressPercentage)}%`
      : undefined;

  return (
    <li className="group border-b border-border-subtle px-3 py-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <QueryStateBadge state={item.state} />
            <DatasourceBadge datasourceId={item.datasourceId} datasources={datasources} />
            <span className="font-mono text-2xs text-ink-subtle">{item.owner}</span>
          </div>
          <p className="mt-1 truncate font-mono text-xs text-ink-base">{oneLine}</p>
          <div className="mt-1 flex items-center gap-3 font-mono text-2xs text-ink-subtle">
            <span>{formatDuration(item.elapsedMs)}</span>
            {progress && <span>{progress}</span>}
          </div>
        </div>
        {canKill && !['finished', 'failed', 'canceled'].includes(item.state) && (
          <Button
            variant="ghost"
            size="sm"
            className={cn('shrink-0 opacity-0 transition-opacity group-hover:opacity-100')}
            disabled={killing}
            onClick={() => onKill(item)}
            aria-label={t('killQueryByAria', { owner: item.owner })}
          >
            <OctagonX size={14} strokeWidth={1.75} />
            {t('killButton')}
          </Button>
        )}
      </div>
    </li>
  );
}

/**
 * Operations サイドバーパネル本体。
 */
export function OperationsPanel() {
  const t = useT(operationsDict);
  const { data: me } = useMe();
  const canView = hasPermission(me, 'queries.viewAll');
  const canKill = hasPermission(me, 'query.killAny');
  const { datasources } = useDatasources();
  const { data, isLoading, isError } = useAdminQueries(canView);
  const kill = useKillAdminQuery();
  const [pendingKill, setPendingKill] = useState<AdminQueryItem | null>(null);

  if (!canView) return null;

  const items = data?.items ?? [];

  return (
    <div className="flex h-full flex-col">
      {isLoading && items.length === 0 ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : isError ? (
        <EmptyState
          icon={Activity}
          title={t('couldNotLoadQueries')}
          description={t('checkConnectionHint')}
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={Activity}
          title={t('noActiveQueries')}
          description={t('allUsersQueriesHint')}
        />
      ) : (
        <ul>
          {items.map((item) => (
            <OperationsRow
              key={item.queryId}
              item={item}
              datasources={datasources}
              canKill={canKill}
              killing={kill.isPending}
              onKill={setPendingKill}
            />
          ))}
        </ul>
      )}

      <Modal
        open={pendingKill !== null}
        onClose={() => setPendingKill(null)}
        title={t('killQueryTitle')}
        description={
          pendingKill
            ? t('killQueryDescription', {
                owner: pendingKill.owner,
                statement: pendingKill.statement.replace(/\s+/g, ' ').trim(),
              })
            : undefined
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingKill(null)}>
              {t('cancel')}
            </Button>
            <Button
              variant="danger"
              disabled={kill.isPending}
              onClick={() => {
                if (!pendingKill) return;
                kill.mutate(pendingKill.queryId, {
                  onSuccess: () =>
                    toast.info(
                      t('queryKilledTitle'),
                      t('queryKilledBody', { owner: pendingKill.owner }),
                    ),
                  onError: () => toast.error(t('killFailedTitle'), t('killFailedBody')),
                });
                setPendingKill(null);
              }}
            >
              {t('killButton')}
            </Button>
          </>
        }
      />
    </div>
  );
}
