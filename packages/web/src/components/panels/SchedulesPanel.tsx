import { useMemo, useState } from 'react';
import type { Schedule } from '@hubble/contracts';
import { CalendarClock, History as HistoryIcon, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { EmptyState } from '../common/EmptyState';
import { Spinner } from '../common/Spinner';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { toast } from '../common/Toast';
import { ApiClientError } from '../../api/client';
import { ScheduleStatusBadge } from './ScheduleStatusBadge';
import { ScheduleFormModal } from './ScheduleFormModal';
import { ScheduleRunsModal } from './ScheduleRunsModal';
import { formatApiError, type FormError } from './scheduleFormat';
import {
  useSchedules,
  useCreateSchedule,
  useUpdateSchedule,
  useDeleteSchedule,
  useRunScheduleNow,
} from '../../hooks/useSchedules';
import { useUiStore } from '../../stores/uiStore';
import { cn } from '../../utils/cn';

/**
 * Schedules panel (Query Scheduling feature) — the assist-sidebar surface for
 * scheduled queries. Lists each schedule with its cron, an enabled toggle, the
 * next computed run, and the last run's status, plus per-row actions (Run now /
 * Edit / Delete / Runs). Creation and editing open a modal form with client-side
 * SQL validation; the run history opens a second modal. The list polls (via the
 * hook) so a `running` run flips to `success` on screen.
 */

/** Relative time, but null/disabled schedules read as a dash. */
function nextRunLabel(schedule: Schedule, now: Date): string {
  if (!schedule.enabled) return 'Disabled';
  if (!schedule.nextRunAt) return '—';
  const then = new Date(schedule.nextRunAt).getTime();
  const diffMs = then - now.getTime();
  if (Number.isNaN(diffMs)) return '—';
  if (diffMs <= 0) return 'due now';
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return 'in <1m';
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.round(hours / 24);
  return `in ${days}d`;
}

function ScheduleRow({
  schedule,
  now,
  onToggleEnabled,
  onRun,
  onEdit,
  onDelete,
  onOpenRuns,
  running,
}: {
  schedule: Schedule;
  now: Date;
  onToggleEnabled: () => void;
  onRun: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onOpenRuns: () => void;
  running: boolean;
}) {
  return (
    <li className="group border-b border-border-subtle px-3 py-2.5">
      <div className="flex items-start gap-2">
        <button
          type="button"
          role="switch"
          aria-checked={schedule.enabled}
          aria-label={schedule.enabled ? 'Disable schedule' : 'Enable schedule'}
          onClick={onToggleEnabled}
          className={cn(
            'mt-0.5 flex h-4 w-7 shrink-0 items-center rounded-full px-0.5 transition-colors',
            schedule.enabled ? 'bg-accent' : 'bg-surface-inset',
          )}
        >
          <span
            className={cn(
              'h-3 w-3 rounded-full bg-surface-base transition-transform',
              schedule.enabled && 'translate-x-3',
            )}
          />
        </button>

        <button
          type="button"
          onClick={onOpenRuns}
          className="min-w-0 flex-1 text-left"
          title="View run history"
        >
          <p className="truncate text-sm font-medium text-ink-strong">{schedule.name}</p>
          <p className="mt-0.5 truncate font-mono text-2xs text-ink-subtle">{schedule.cron}</p>
        </button>
      </div>

      <div className="mt-1.5 flex items-center gap-2 pl-9">
        {schedule.lastRun ? (
          <ScheduleStatusBadge status={schedule.lastRun.status} />
        ) : (
          <span className="font-mono text-2xs text-ink-subtle">never run</span>
        )}
        <span className="font-mono text-2xs text-ink-subtle">
          next {nextRunLabel(schedule, now)}
        </span>
      </div>

      <div className="mt-2 flex items-center gap-1 pl-9 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <Button variant="default" size="sm" icon={Play} onClick={onRun} disabled={running}>
          {running ? 'Running…' : 'Run now'}
        </Button>
        <Button variant="ghost" size="sm" icon={HistoryIcon} onClick={onOpenRuns}>
          Runs
        </Button>
        <Button variant="ghost" size="sm" icon={Pencil} onClick={onEdit}>
          Edit
        </Button>
        <Button
          variant="ghost"
          size="sm"
          icon={Trash2}
          onClick={onDelete}
          className="ml-auto text-ink-subtle hover:text-error"
          aria-label="Delete schedule"
        />
      </div>
    </li>
  );
}

export function SchedulesPanel({ search }: { search: string }) {
  const context = useUiStore((s) => s.shellContext);
  const list = useSchedules();
  const create = useCreateSchedule();
  const update = useUpdateSchedule();
  const remove = useDeleteSchedule();
  const runNow = useRunScheduleNow();

  // Modal state. `formOpen` covers both create (editing === null) and edit.
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [serverError, setServerError] = useState<FormError | null>(null);
  const [runsFor, setRunsFor] = useState<Schedule | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Schedule | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);

  const now = new Date();

  const openCreate = () => {
    setEditing(null);
    setServerError(null);
    setFormOpen(true);
  };
  const openEdit = (schedule: Schedule) => {
    setEditing(schedule);
    setServerError(null);
    setFormOpen(true);
  };
  const closeForm = () => {
    setFormOpen(false);
    setEditing(null);
    setServerError(null);
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const items = list.data ?? [];
    const matched = q
      ? items.filter(
          (s) => s.name.toLowerCase().includes(q) || s.statement.toLowerCase().includes(q),
        )
      : items;
    return [...matched].sort((a, b) => a.name.localeCompare(b.name));
  }, [list.data, search]);

  const runSchedule = (schedule: Schedule) => {
    setRunningId(schedule.id);
    runNow.mutate(schedule.id, {
      onSuccess: () => {
        toast.info('Run started', `“${schedule.name}” is running.`);
        setRunsFor(schedule);
      },
      onError: (error) => {
        if (error instanceof ApiClientError && error.status === 409) {
          toast.error('Already running', 'This schedule has a run in progress.');
        } else {
          toast.error('Run failed', 'Could not start the run.');
        }
      },
      onSettled: () => setRunningId(null),
    });
  };

  const toggleEnabled = (schedule: Schedule) => {
    update.mutate(
      { id: schedule.id, body: { enabled: !schedule.enabled } },
      { onError: () => toast.error('Update failed', 'Could not reach the server.') },
    );
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
        icon={CalendarClock}
        title="Couldn't load schedules"
        description="The server didn't respond."
        compact
      />
    );
  }

  return (
    <div className="flex flex-col">
      <div className="px-3 pb-2">
        <Button
          variant="default"
          size="sm"
          icon={Plus}
          onClick={openCreate}
          className="w-full justify-center"
        >
          New schedule
        </Button>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title={search.trim() ? 'No matches' : 'No schedules'}
          description={
            search.trim()
              ? 'Try a different search term.'
              : 'Create a schedule to run a query on a cron cadence.'
          }
          compact
        />
      ) : (
        <ul className="flex flex-col">
          {filtered.map((schedule) => (
            <ScheduleRow
              key={schedule.id}
              schedule={schedule}
              now={now}
              running={runningId === schedule.id}
              onToggleEnabled={() => toggleEnabled(schedule)}
              onRun={() => runSchedule(schedule)}
              onEdit={() => openEdit(schedule)}
              onDelete={() => setPendingDelete(schedule)}
              onOpenRuns={() => setRunsFor(schedule)}
            />
          ))}
        </ul>
      )}

      <ScheduleFormModal
        open={formOpen}
        schedule={editing}
        context={context}
        submitting={create.isPending || update.isPending}
        serverError={serverError}
        onClose={closeForm}
        onCreate={(body) => {
          setServerError(null);
          create.mutate(body, {
            onSuccess: (created) => {
              toast.success('Schedule created', `“${created.name}” is ready.`);
              closeForm();
            },
            onError: (error) => setServerError(formatApiError(error)),
          });
        }}
        onUpdate={(body) => {
          if (!editing) return;
          setServerError(null);
          update.mutate(
            { id: editing.id, body },
            {
              onSuccess: (updated) => {
                toast.success('Schedule updated', `“${updated.name}” saved.`);
                closeForm();
              },
              onError: (error) => setServerError(formatApiError(error)),
            },
          );
        }}
      />

      <ScheduleRunsModal schedule={runsFor} onClose={() => setRunsFor(null)} />

      <Modal
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title="Delete schedule?"
        description={
          pendingDelete ? `“${pendingDelete.name}” will be permanently removed.` : undefined
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
                    onSuccess: () => toast.info('Deleted', 'Schedule removed.'),
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
