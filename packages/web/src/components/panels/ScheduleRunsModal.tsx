/**
 * スケジュールの実行履歴（Runs）を表示するモーダル（クエリスケジューラー機能）。
 *
 * SchedulesPanel の各行（または「Runs」ボタン）から開かれ、対象スケジュールの
 * 実行履歴を新しい順に一覧表示する。各実行行には状態バッジ、試行回数、行数、
 * 所要時間、trinoQueryId、エラー内容を表示し、リトライの末に失敗した実行は
 * 「N attempts」という表記で一目で分かるようにしている。データ取得は
 * `useScheduleRuns` フックに委譲する。
 */
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

/**
 * 実行履歴 1 件分を描画する行コンポーネント。
 *
 * @param run 表示対象の実行結果（状態、試行回数、行数、所要時間、エラー等）。
 * @param now 相対時刻表示の基準となる現在時刻。
 */
function RunRow({ run, now }: { run: ScheduleRun; now: Date }) {
  // 失敗かつ 2 回以上試行していた場合のみ「リトライ済み」として扱う。
  const retried = run.status === 'failed' && run.attempt > 1;
  return (
    <li className="border-b border-border-subtle px-4 py-2.5">
      {/* 状態バッジ、試行回数（複数回のときのみ）、開始時刻の相対表示 */}
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

      {/* 行数、所要時間、試行回数、trinoQueryId のメタデータ一覧 */}
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

      {/* エラーメッセージ（存在する場合）。errorType があれば接頭辞として付け、
          リトライ後の失敗であれば試行回数を併記する。 */}
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

/**
 * スケジュール実行履歴モーダル本体。
 *
 * @param schedule 表示対象のスケジュール。null のときはモーダルを閉じた状態として扱う
 *   （`open` の判定と `useScheduleRuns` への id 引き渡しの両方に使われる）。
 * @param onClose モーダルを閉じるときに呼び出されるコールバック。
 */
export function ScheduleRunsModal({
  schedule,
  onClose,
}: {
  schedule: Schedule | null;
  onClose: () => void;
}) {
  // schedule が null でなければモーダルを開いた状態として扱う。
  const open = schedule !== null;
  // 対象スケジュールの実行履歴を取得するフック。schedule が無ければ id は null を渡す。
  const runs = useScheduleRuns(schedule?.id ?? null);
  // 相対時刻表示の基準時刻。
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
        {/* ローディング中／エラー時／0 件時／通常時の 4 パターンを出し分ける。 */}
        {runs.isPending ? (
          // 取得中はスピナーを表示する。
          <div className="flex items-center justify-center gap-2 py-10 font-mono text-2xs text-ink-subtle">
            <Spinner size={14} /> Loading…
          </div>
        ) : runs.isError ? (
          // 取得エラー時の空状態表示。
          <EmptyState
            icon={History}
            title="Couldn't load runs"
            description="The server didn't respond."
            compact
          />
        ) : (runs.data?.length ?? 0) === 0 ? (
          // 実行履歴がまだ 0 件の場合の空状態表示。
          <EmptyState
            icon={History}
            title="No runs yet"
            description="Runs appear here once the schedule fires or you trigger it manually."
            compact
          />
        ) : (
          // 実行履歴一覧本体（新しい順）。
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
