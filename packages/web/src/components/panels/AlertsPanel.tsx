/**
 * Alert 一覧パネル（サイドバー）。
 */
import { useMemo, useState } from 'react';
import type { Alert } from '@hubble/contracts';
import { Bell, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { EmptyState } from '../common/EmptyState';
import { Spinner } from '../common/Spinner';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { toast } from '../common/Toast';
import { ApiClientError } from '../../api/client';
import { AlertStateBadge } from './AlertStateBadge';
import { AlertFormModal, alertToRequest } from './AlertFormModal';
import {
  useAlerts,
  useCreateAlert,
  useUpdateAlert,
  useDeleteAlert,
  useEvalAlertNow,
} from '../../hooks/useAlerts';
import { listSavedQueries } from '../../api/savedQueries';
import { cn } from '../../utils/cn';
import { useT, type TFn } from '../../i18n/t';
import { useLocale } from '../../i18n/locale';
import { commonMessages } from '../../i18n/messages/common';
import { alertMessages } from '../../i18n/messages/alert';
import { alertSelectorLabel, alertStateLabel } from './alertFormat';
import { describeCronForList } from './scheduleCron';

/** AlertsPanel 内で使う辞書の合成。共通文言 + Alert 固有文言を 1 つの t() で引けるようにする。 */
const alertDict = { ...commonMessages, ...alertMessages } as const;

/**
 * 「次回評価予定」を人間可読な文字列に変換するヘルパー。
 * ミュート中は「ミュート中」、次回評価時刻が未算出なら「—」、既に到来していれば
 * 「まもなく評価」、それ以外は分/時/日単位のおおよその残り時間を返す。
 *
 * @param t 呼び出し元コンポーネントの useT で得た翻訳関数（alertDict に束縛済み）。
 */
function nextEvalLabel(alert: Alert, now: Date, t: TFn<typeof alertDict>): string {
  if (alert.muted) return t('muted');
  if (!alert.nextEvalAt) return t('unknown');
  const then = new Date(alert.nextEvalAt).getTime();
  const diffMs = then - now.getTime();
  if (Number.isNaN(diffMs)) return t('unknown');
  // common.dueNow は「実行」を指す言い回しなので使わず、Alert の「評価」に合わせた
  // 専用エントリを使う（レビュー指摘: 意味の異なる訳の使い回しを解消）。
  if (diffMs <= 0) return t('evalDueNow');
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return t('relativeLessThanOneMinute');
  if (minutes < 60) return t('relativeMinutes', { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t('relativeHours', { n: hours });
  return t('relativeDays', { n: Math.round(hours / 24) });
}

function AlertRow({
  alert,
  now,
  evaluating,
  onToggleMuted,
  onEval,
  onEdit,
  onDelete,
}: {
  alert: Alert;
  now: Date;
  evaluating: boolean;
  onToggleMuted: () => void;
  onEval: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const t = useT(alertDict);
  const { locale } = useLocale();
  return (
    <li className="group border-b border-border-subtle px-3 py-2.5">
      <div className="flex items-start gap-2">
        <button
          type="button"
          role="switch"
          aria-checked={!alert.muted}
          aria-label={alert.muted ? t('unmuteAlert') : t('muteAlert')}
          onClick={onToggleMuted}
          className={cn(
            'mt-0.5 flex h-4 w-7 shrink-0 items-center rounded-full px-0.5 transition-colors',
            !alert.muted ? 'bg-accent' : 'bg-surface-inset',
          )}
        >
          <span
            className={cn(
              'h-3 w-3 rounded-full bg-surface-base transition-transform',
              !alert.muted && 'translate-x-3',
            )}
          />
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-ink-strong">{alert.name}</p>
          {/* columnName / op / value は契約層の値そのもの（列名や演算子記号）であり、
              翻訳対象の UI 文言ではないためそのまま表示する。selector だけはフォームと
              同じ表示ラベルに翻訳する（レビュー指摘: 一覧だけ契約値が生表示のままだった）。 */}
          <p className="mt-0.5 truncate font-mono text-2xs text-ink-muted">
            {alert.columnName} {alert.op} {alert.value} (
            {alertSelectorLabel(alert.selector, locale)})
          </p>
        </div>
      </div>

      {/* 状態バッジと cron の読み下し、次回評価予定の相対表示 (SchedulesPanel と同じ
          2 段目レイアウト)。生の cron 式は表示せず、SchedulesPanel と同じ
          describeCronForList で読み下す（UI/UX から cron 式表示を極力排除する方針）。 */}
      <div className="mt-1.5 flex flex-wrap items-center gap-2 pl-9">
        <AlertStateBadge state={alert.state} />
        <span className="text-2xs text-ink-subtle">{describeCronForList(alert.cron, locale)}</span>
        <span className="font-mono text-2xs text-ink-subtle">
          {t('nextPrefix', { label: nextEvalLabel(alert, now, t) })}
        </span>
      </div>

      {/* 行アクション列。通常は透明で、行ホバーまたはフォーカス時のみ表示される。
          flex-wrap: SchedulesPanel と同じ理由（狭いサイドバー幅での日本語ラベル
          overflow 対策）で折り返しを許容する。 */}
      <div className="mt-2 flex flex-wrap items-center gap-1 pl-9 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <Button variant="default" size="sm" icon={Play} onClick={onEval} disabled={evaluating}>
          {evaluating ? t('evaluating') : t('evalNow')}
        </Button>
        <Button variant="ghost" size="sm" icon={Pencil} onClick={onEdit}>
          {t('edit')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          icon={Trash2}
          onClick={onDelete}
          className="ml-auto text-ink-subtle hover:text-error"
          aria-label={t('deleteAlertAria')}
        />
      </div>
    </li>
  );
}

/** Alert 一覧パネル。 */
export function AlertsPanel({ search }: { search: string }) {
  const t = useT(alertDict);
  const { locale } = useLocale();
  const list = useAlerts(true);
  const savedQueriesQuery = useQuery({
    queryKey: ['saved-queries', 'list'],
    queryFn: () => listSavedQueries(),
  });
  const create = useCreateAlert();
  const update = useUpdateAlert();
  const remove = useDeleteAlert();
  const evalNow = useEvalAlertNow();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Alert | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Alert | null>(null);
  const [evaluatingId, setEvaluatingId] = useState<string | null>(null);
  const now = useMemo(() => new Date(), [list.data]);

  // 検索語で絞り込み、名前順に並べ替える (Schedules/Workflows と同じ規則)。
  const filtered = useMemo(() => {
    const items = list.data ?? [];
    const q = search.trim().toLowerCase();
    const matched = q
      ? items.filter(
          (a) =>
            a.name.toLowerCase().includes(q) ||
            a.columnName.toLowerCase().includes(q) ||
            a.savedQueryId.toLowerCase().includes(q),
        )
      : items;
    return [...matched].sort((a, b) => a.name.localeCompare(b.name));
  }, [list.data, search]);

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };
  const openEdit = (alert: Alert) => {
    setEditing(alert);
    setFormOpen(true);
  };
  const closeForm = () => {
    setFormOpen(false);
    setEditing(null);
  };

  const toggleMuted = (alert: Alert) => {
    update.mutate(
      { id: alert.id, body: { ...alertToRequest(alert), muted: !alert.muted } },
      { onError: () => toast.error(t('updateFailed'), t('couldNotReachServer')) },
    );
  };

  const runEval = (alert: Alert) => {
    setEvaluatingId(alert.id);
    evalNow.mutate(alert.id, {
      onSuccess: (result) => {
        // result.errorMessage はサーバー由来のエラー本文（スコープ外、翻訳しない）。
        // result.state（契約値 ok/triggered/unknown）は AlertStateBadge と同じ
        // alertStateLabel で翻訳する（レビュー指摘: トーストだけ契約値が生表示だった）。
        const msg = result.notified
          ? t('notificationSent')
          : result.errorMessage
            ? result.errorMessage
            : t('evalStateBody', { state: alertStateLabel(result.state, locale) });
        toast.info(t('evaluationCompleteTitle'), msg);
      },
      onError: (error) => {
        if (error instanceof ApiClientError && error.status === 409) {
          toast.error(t('alreadyEvaluatingTitle'), t('alreadyEvaluatingBody'));
        } else {
          toast.error(t('evaluationFailedTitle'), t('evaluationFailedBody'));
        }
      },
      onSettled: () => setEvaluatingId(null),
    });
  };

  if (list.isPending) {
    return (
      <div className="flex items-center justify-center gap-2 py-8 font-mono text-2xs text-ink-subtle">
        <Spinner size={14} /> {t('loading')}
      </div>
    );
  }

  if (list.isError) {
    return (
      <EmptyState
        icon={Bell}
        title={t('couldntLoadAlerts')}
        description={t('serverDidntRespond')}
        compact
      />
    );
  }

  const savedQueries = savedQueriesQuery.data ?? [];

  return (
    <div className="flex flex-col">
      <div className="px-3 pb-2">
        <Button
          variant="default"
          size="sm"
          icon={Plus}
          onClick={openCreate}
          className="w-full justify-center"
          disabled={savedQueries.length === 0}
        >
          {t('newAlert')}
        </Button>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={Bell}
          title={search.trim() ? t('noMatches') : t('noAlerts')}
          description={
            search.trim()
              ? t('tryDifferentSearchTerm')
              : savedQueries.length === 0
                ? t('saveQueryFirstHint')
                : t('createAlertHint')
          }
          compact
        />
      ) : (
        <ul className="flex flex-col">
          {filtered.map((alert) => (
            <AlertRow
              key={alert.id}
              alert={alert}
              now={now}
              evaluating={evaluatingId === alert.id}
              onToggleMuted={() => toggleMuted(alert)}
              onEval={() => runEval(alert)}
              onEdit={() => openEdit(alert)}
              onDelete={() => setPendingDelete(alert)}
            />
          ))}
        </ul>
      )}

      <AlertFormModal
        open={formOpen}
        alert={editing}
        savedQueries={savedQueries}
        submitting={create.isPending || update.isPending}
        onClose={closeForm}
        onCreate={(body) => {
          create.mutate(body, {
            onSuccess: (created) => {
              toast.success(t('alertCreatedTitle'), t('entityReadyBody', { name: created.name }));
              closeForm();
            },
            onError: () => toast.error(t('createFailedTitle'), t('couldNotReachServer')),
          });
        }}
        onUpdate={(body) => {
          if (!editing) return;
          update.mutate(
            { id: editing.id, body },
            {
              onSuccess: (updated) => {
                toast.success(t('alertUpdatedTitle'), t('entitySavedBody', { name: updated.name }));
                closeForm();
              },
              onError: () => toast.error(t('updateFailed'), t('couldNotReachServer')),
            },
          );
        }}
      />

      <Modal
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title={t('deleteAlertTitle')}
        description={
          pendingDelete ? t('deleteConfirmDescription', { name: pendingDelete.name }) : undefined
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              {t('cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (pendingDelete) {
                  remove.mutate(pendingDelete.id, {
                    onSuccess: () => toast.info(t('deleted'), t('alertRemoved')),
                    onError: () => toast.error(t('deleteFailed'), t('couldNotReachServer')),
                  });
                }
                setPendingDelete(null);
              }}
            >
              {t('delete')}
            </Button>
          </>
        }
      />
    </div>
  );
}
