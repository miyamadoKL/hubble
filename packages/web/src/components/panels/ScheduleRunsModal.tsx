import type { Schedule, ScheduleRun } from '@hubble/contracts';
import { History } from 'lucide-react';
import { Modal } from '../common/Modal';
import { EmptyState } from '../common/EmptyState';
import { Spinner } from '../common/Spinner';
import { ScheduleStatusBadge } from './ScheduleStatusBadge';
import { attemptLabel } from './scheduleFormat';
import { useScheduleRuns } from '../../hooks/useSchedules';
import { formatDuration, formatInt, formatRelativeTime } from '../../utils/format';

/**
 * Run-history view for one schedule (Query Scheduling feature). Lists runs newest
 * first with status / attempt / rowCount / elapsed / error / trinoQueryId / time.
 * A failed run with attempt > 1 reads "N attempts" so an exhausted retry chain is
 * legible at a glance.
 */

function RunRow({ run, now }: { run: ScheduleRun; now: Date }) {
  const retried = run.status === 'failed' && run.attempt > 1;
  return (
    <li className="border-b border-border-subtle px-4 py-2.5">
      <div className="flex items-center gap-2">
        <ScheduleStatusBadge status={run.status} />
        {run.attempt > 1 && (
          <span
            className="font-mono text-2xs text-warning"
            title={`This run took ${run.attempt} attempts`}
          >
            {attemptLabel(run.attempt)}
          </span>
        )}
        <span className="ml-auto font-mono text-2xs text-ink-subtle">
          {formatRelativeTime(run.startedAt, now)}
        </span>
      </div>

      <dl className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-0.5 font-mono text-2xs text-ink-subtle sm:grid-cols-4">
        <div className="flex gap-1.5">
          <dt>rows</dt>
          <dd className="text-ink-muted">{run.rowCount != null ? formatInt(run.rowCount) : '—'}</dd>
        </div>
        <div className="flex gap-1.5">
          <dt>elapsed</dt>
          <dd className="text-ink-muted">
            {run.elapsedMs != null ? formatDuration(run.elapsedMs) : '—'}
          </dd>
        </div>
        <div className="flex gap-1.5">
          <dt>attempt</dt>
          <dd className="text-ink-muted">{run.attempt}</dd>
        </div>
        {run.trinoQueryId && (
          <div className="col-span-2 flex min-w-0 gap-1.5 sm:col-span-1">
            <dt>query</dt>
            <dd className="truncate text-ink-muted">{run.trinoQueryId}</dd>
          </div>
        )}
      </dl>

      {run.errorMessage && (
        <p className="mt-1.5 font-mono text-2xs whitespace-pre-wrap text-error">
          {run.errorType ? `${run.errorType}: ` : ''}
          {run.errorMessage}
          {retried && (
            <span className="text-error/80"> (failed after {attemptLabel(run.attempt)})</span>
          )}
        </p>
      )}
    </li>
  );
}

export function ScheduleRunsModal({
  schedule,
  onClose,
}: {
  schedule: Schedule | null;
  onClose: () => void;
}) {
  const open = schedule !== null;
  const runs = useScheduleRuns(schedule?.id ?? null);
  const now = new Date();

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={schedule ? `Runs — ${schedule.name}` : 'Runs'}
      description="Most recent runs first. A failed run that exhausted its retries shows the attempt count."
      className="max-w-2xl"
    >
      <div className="-mx-5 -my-4 max-h-[60vh] overflow-auto">
        {runs.isPending ? (
          <div className="flex items-center justify-center gap-2 py-10 font-mono text-2xs text-ink-subtle">
            <Spinner size={14} /> Loading…
          </div>
        ) : runs.isError ? (
          <EmptyState
            icon={History}
            title="Couldn't load runs"
            description="The server didn't respond."
            compact
          />
        ) : (runs.data?.length ?? 0) === 0 ? (
          <EmptyState
            icon={History}
            title="No runs yet"
            description="Runs appear here once the schedule fires or you trigger it manually."
            compact
          />
        ) : (
          <ul className="flex flex-col">
            {runs.data!.map((run) => (
              <RunRow key={run.id} run={run} now={now} />
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
