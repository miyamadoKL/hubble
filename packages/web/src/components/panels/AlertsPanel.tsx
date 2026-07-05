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

function nextEvalLabel(alert: Alert, now: Date): string {
  if (alert.muted) return 'Muted';
  if (!alert.nextEvalAt) return '—';
  const then = new Date(alert.nextEvalAt).getTime();
  const diffMs = then - now.getTime();
  if (Number.isNaN(diffMs)) return '—';
  if (diffMs <= 0) return 'due now';
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return 'in <1m';
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
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
  return (
    <li className="group border-b border-border-subtle px-3 py-2.5">
      <div className="flex items-start gap-2">
        <button
          type="button"
          role="switch"
          aria-checked={!alert.muted}
          aria-label={alert.muted ? 'Unmute alert' : 'Mute alert'}
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
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-ink-strong">{alert.name}</span>
            <AlertStateBadge state={alert.state} />
          </div>
          <p className="mt-0.5 font-mono text-2xs text-ink-muted">
            {alert.columnName} {alert.op} {alert.value} ({alert.selector})
          </p>
          <p className="mt-0.5 font-mono text-2xs text-ink-subtle">
            {alert.cron} · {nextEvalLabel(alert, now)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <Button
            variant="ghost"
            size="sm"
            aria-label="Evaluate now"
            disabled={evaluating}
            icon={Play}
            onClick={onEval}
          />
          <Button variant="ghost" size="sm" aria-label="Edit" icon={Pencil} onClick={onEdit} />
          <Button variant="ghost" size="sm" aria-label="Delete" icon={Trash2} onClick={onDelete} />
        </div>
      </div>
    </li>
  );
}

/** Alert 一覧パネル。 */
export function AlertsPanel({ search }: { search: string }) {
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

  const filtered = useMemo(() => {
    const items = list.data ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.columnName.toLowerCase().includes(q) ||
        a.savedQueryId.toLowerCase().includes(q),
    );
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
      { onError: () => toast.error('Update failed', 'Could not reach the server.') },
    );
  };

  const runEval = (alert: Alert) => {
    setEvaluatingId(alert.id);
    evalNow.mutate(alert.id, {
      onSuccess: (result) => {
        const msg = result.notified
          ? 'Notification sent'
          : result.errorMessage
            ? result.errorMessage
            : `State: ${result.state}`;
        toast.info('Evaluation complete', msg);
      },
      onError: (error) => {
        if (error instanceof ApiClientError && error.status === 409) {
          toast.error('Already evaluating', 'This alert is being evaluated.');
        } else {
          toast.error('Evaluation failed', 'Could not evaluate the alert.');
        }
      },
      onSettled: () => setEvaluatingId(null),
    });
  };

  if (list.isPending) {
    return (
      <div className="flex items-center justify-center gap-2 py-8 font-mono text-2xs text-ink-subtle">
        <Spinner size={14} /> Loading…
      </div>
    );
  }

  if (list.isError) {
    return (
      <EmptyState
        icon={Bell}
        title="Couldn't load alerts"
        description="The server didn't respond."
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
          New alert
        </Button>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={Bell}
          title={search.trim() ? 'No matches' : 'No alerts'}
          description={
            search.trim()
              ? 'Try a different search term.'
              : savedQueries.length === 0
                ? 'Save a query first, then create an alert.'
                : 'Create an alert to monitor query results.'
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
              toast.success('Alert created', `"${created.name}" is ready.`);
              closeForm();
            },
            onError: () => toast.error('Create failed', 'Could not reach the server.'),
          });
        }}
        onUpdate={(body) => {
          if (!editing) return;
          update.mutate(
            { id: editing.id, body },
            {
              onSuccess: (updated) => {
                toast.success('Alert updated', `"${updated.name}" saved.`);
                closeForm();
              },
              onError: () => toast.error('Update failed', 'Could not reach the server.'),
            },
          );
        }}
      />

      <Modal
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title="Delete alert?"
        description={
          pendingDelete ? `"${pendingDelete.name}" will be permanently removed.` : undefined
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (pendingDelete) {
                  remove.mutate(pendingDelete.id, {
                    onSuccess: () => toast.info('Deleted', 'Alert removed.'),
                    onError: () => toast.error('Delete failed', 'Could not reach the server.'),
                  });
                }
                setPendingDelete(null);
              }}
            >
              Delete
            </Button>
          </>
        }
      />
    </div>
  );
}
