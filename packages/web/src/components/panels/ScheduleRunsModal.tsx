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
import { useLocale } from '../../i18n/locale';
import { useT } from '../../i18n/t';
import { commonMessages } from '../../i18n/messages/common';
import { scheduleRunMessages } from '../../i18n/messages/scheduleRun';

/** ScheduleRunsModal 内で使う辞書の合成。 */
const scheduleRunDict = { ...commonMessages, ...scheduleRunMessages } as const;

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
  const { locale } = useLocale();
  const t = useT(scheduleRunMessages);
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
            title={t('tookNAttempts', { n: run.attempt })}
          >
            {attemptLabel(run.attempt, locale)}
          </span>
        )}
        <span className="ml-auto font-mono text-2xs text-ink-subtle">
          {formatRelativeTime(run.startedAt, now, locale)}
        </span>
      </div>

      {/* 行数、所要時間、試行回数、trinoQueryId のメタデータ一覧 */}
      <dl className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-0.5 font-mono text-2xs text-ink-subtle sm:grid-cols-4">
        <div className="flex gap-1.5">
          <dt>{t('rowsItem')}</dt>
          <dd className="text-ink-muted">{run.rowCount != null ? formatInt(run.rowCount) : '—'}</dd>
        </div>
        <div className="flex gap-1.5">
          <dt>{t('elapsedItem')}</dt>
          <dd className="text-ink-muted">
            {run.elapsedMs != null ? formatDuration(run.elapsedMs) : '—'}
          </dd>
        </div>
        <div className="flex gap-1.5">
          <dt>{t('attemptItem')}</dt>
          <dd className="text-ink-muted">{run.attempt}</dd>
        </div>
        {run.trinoQueryId && (
          <div className="col-span-2 flex min-w-0 gap-1.5 sm:col-span-1">
            <dt>{t('queryItem')}</dt>
            <dd className="truncate text-ink-muted">{run.trinoQueryId}</dd>
          </div>
        )}
      </dl>

      {/* エラーメッセージ（存在する場合。サーバー由来の生テキストなので翻訳しない）。
          errorType があれば接頭辞として付け、リトライ後の失敗であれば試行回数を併記する。 */}
      {run.errorMessage && (
        <p className="mt-1.5 font-mono text-2xs whitespace-pre-wrap text-error">
          {run.errorType ? `${run.errorType}: ` : ''}
          {run.errorMessage}
          {retried && (
            <span className="text-error/80">
              {t('failedAfterAttempts', { label: attemptLabel(run.attempt, locale) })}
            </span>
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
  const t = useT(scheduleRunDict);
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
      title={schedule ? t('runsTitleFor', { name: schedule.name }) : t('runsTitle')}
      description={t('runsDescription')}
      className="max-w-2xl"
    >
      <div className="-mx-5 -my-4 max-h-[60vh] overflow-auto">
        {/* ローディング中／エラー時／0 件時／通常時の 4 パターンを出し分ける。 */}
        {runs.isPending ? (
          // 取得中はスピナーを表示する。
          <div className="flex items-center justify-center gap-2 py-10 font-mono text-2xs text-ink-subtle">
            <Spinner size={14} /> {t('loading')}
          </div>
        ) : runs.isError ? (
          // 取得エラー時の空状態表示。
          <EmptyState
            icon={History}
            title={t('couldntLoadRuns')}
            description={t('serverDidntRespond')}
            compact
          />
        ) : (runs.data?.length ?? 0) === 0 ? (
          // 実行履歴がまだ 0 件の場合の空状態表示。
          <EmptyState
            icon={History}
            title={t('noRunsYetTitle')}
            description={t('noRunsYetDescription')}
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
