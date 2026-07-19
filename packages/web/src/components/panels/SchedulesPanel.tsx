/**
 * スケジュール一覧パネル（クエリスケジューラー機能のメイン画面）。
 *
 * アシストサイドバーに表示される、cron スケジュールで定期実行される SQL クエリの
 * 一覧と管理の画面。各行に cron 式、有効/無効トグル、次回実行予定、最終実行結果を表示し、
 * 行ホバー時に Run now（今すぐ実行）/ Runs（実行履歴）/ Edit（編集）/ Delete（削除）の
 * アクションを出す。新規作成と編集はフォームモーダル（ScheduleFormModal）、実行履歴は
 * 別モーダル（ScheduleRunsModal）に委譲する。一覧データは `useSchedules` フック側で
 * ポーリングされており、実行中のスケジュールが完了すると自動で状態が更新される。
 */
import { useMemo, useState } from 'react';
import type { SavedQuery, Schedule } from '@hubble/contracts';
import { useQuery } from '@tanstack/react-query';
import { CalendarClock, History as HistoryIcon, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { EmptyState } from '../common/EmptyState';
import { Spinner } from '../common/Spinner';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { toast } from '../common/Toast';
import { ApiClientError } from '../../api/client';
import { listSavedQueries } from '../../api/savedQueries';
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
import { useDatasources } from '../../hooks/useDatasources';
import { DatasourceBadge } from '../common/DatasourceBadge';
import { cn } from '../../utils/cn';
import { useT, type TFn } from '../../i18n/t';
import { commonMessages } from '../../i18n/messages/common';
import { scheduleMessages } from '../../i18n/messages/schedule';

/** SchedulesPanel 内で使う辞書の合成。共通文言 + Schedule 固有文言を 1 つの t() で引けるようにする。 */
const scheduleDict = { ...commonMessages, ...scheduleMessages } as const;

/**
 * Schedules panel (Query Scheduling feature) — the assist-sidebar surface for
 * scheduled queries. Lists each schedule with its cron, an enabled toggle, the
 * next computed run, and the last run's status, plus per-row actions (Run now /
 * Edit / Delete / Runs). Creation and editing open a modal form with client-side
 * SQL validation; the run history opens a second modal. The list polls (via the
 * hook) so a `running` run flips to `success` on screen.
 */

/**
 * 「次回実行予定」を人間可読な文字列に変換するヘルパー。
 * 無効化されているスケジュールは「無効」、次回実行時刻が未算出なら「—」、
 * 既に到来していれば「まもなく実行」、それ以外は分/時/日単位のおおよその残り時間を返す。
 *
 * @param t 呼び出し元コンポーネントの useT で得た翻訳関数（scheduleDict に束縛済み）。
 */
function nextRunLabel(schedule: Schedule, now: Date, t: TFn<typeof scheduleDict>): string {
  if (!schedule.enabled) return t('disabled');
  if (!schedule.nextRunAt) return t('unknown');
  const then = new Date(schedule.nextRunAt).getTime();
  const diffMs = then - now.getTime();
  if (Number.isNaN(diffMs)) return t('unknown');
  if (diffMs <= 0) return t('dueNow');
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return t('relativeLessThanOneMinute');
  if (minutes < 60) return t('relativeMinutes', { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t('relativeHours', { n: hours });
  const days = Math.round(hours / 24);
  return t('relativeDays', { n: days });
}

/**
 * スケジュール一覧の 1 行分を描画するコンポーネント。
 * 有効/無効トグルスイッチ、名前、cron 式、最終実行の状態バッジ、次回実行予定を常時表示し、
 * ホバー（またはフォーカス）時のみ Run now / Runs / Edit / Delete のアクションボタン列を表示する。
 *
 * @param schedule 表示対象のスケジュール。
 * @param now 「次回実行まで」の相対計算に使う現在時刻。
 * @param onToggleEnabled 有効/無効トグルスイッチ押下時のコールバック。
 * @param onRun 「Run now」ボタン押下時のコールバック（今すぐ実行をトリガーする）。
 * @param onEdit 「Edit」ボタン押下時のコールバック（編集モーダルを開く）。
 * @param onDelete 「Delete」ボタン押下時のコールバック（削除確認モーダルを開く）。
 * @param onOpenRuns 行本体または「Runs」ボタン押下時のコールバック（実行履歴モーダルを開く）。
 * @param running このスケジュールが現在「今すぐ実行」処理中かどうか（true の間は Run now を無効化）。
 */
function ScheduleRow({
  schedule,
  now,
  datasources,
  savedQuery,
  onToggleEnabled,
  onRun,
  onEdit,
  onDelete,
  onOpenRuns,
  running,
}: {
  schedule: Schedule;
  now: Date;
  datasources: ReturnType<typeof useDatasources>['datasources'];
  /** schedule.savedQueryId が指す保存済みクエリ（未取得/アクセス不能なら undefined）。 */
  savedQuery: SavedQuery | undefined;
  onToggleEnabled: () => void;
  onRun: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onOpenRuns: () => void;
  running: boolean;
}) {
  const t = useT(scheduleDict);
  return (
    <li className="group border-b border-border-subtle px-3 py-2.5">
      <div className="flex items-start gap-2">
        {/* 有効/無効を切り替えるトグルスイッチ（role="switch" で ON/OFF を表す）。 */}
        <button
          type="button"
          role="switch"
          aria-checked={schedule.enabled}
          aria-label={schedule.enabled ? t('disableSchedule') : t('enableSchedule')}
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

        {/* 名前と cron 式。クリックすると実行履歴モーダルを開く。 */}
        <button
          type="button"
          onClick={onOpenRuns}
          className="min-w-0 flex-1 text-left"
          title={t('viewRunHistory')}
        >
          <p className="truncate text-sm font-medium text-ink-strong">{schedule.name}</p>
          <p className="mt-0.5 truncate font-mono text-2xs text-ink-subtle">{schedule.cron}</p>
        </button>
      </div>

      {/* 最終実行の状態バッジ（未実行なら「未実行」）と、次回実行予定の相対表示。
          実行先データソースは schedule 自体では保持しないため、参照している
          保存済みクエリ（savedQuery）から解決する。 */}
      <div className="mt-1.5 flex flex-wrap items-center gap-2 pl-9">
        {schedule.lastRun ? (
          <ScheduleStatusBadge status={schedule.lastRun.status} />
        ) : (
          <span className="font-mono text-2xs text-ink-subtle">{t('neverRun')}</span>
        )}
        <DatasourceBadge datasourceId={savedQuery?.datasourceId} datasources={datasources} />
        <span className="font-mono text-2xs text-ink-subtle">
          {t('nextRunPrefix', { label: nextRunLabel(schedule, now, t) })}
        </span>
      </div>

      {/* 行アクション列。通常は透明で、行ホバーまたはフォーカス時のみ表示される。
          flex-wrap: サイドバーが既定の狭い幅（288px）のとき、日本語ラベル
          （「今すぐ実行」「実行履歴」「編集」）は英語より幅を取り、1 行に収まらず
          横スクロールを誘発していた（レビュー指摘の e2e overflow 検査で検出）。
          折り返しを許容してこれを解消する（本数は変わらないので視覚的な破綻はない）。 */}
      <div className="mt-2 flex flex-wrap items-center gap-1 pl-9 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        {/* 今すぐ実行。実行中は disabled にしてラベルを "Running…" に切り替える。 */}
        <Button variant="default" size="sm" icon={Play} onClick={onRun} disabled={running}>
          {running ? t('running') : t('runNow')}
        </Button>
        <Button variant="ghost" size="sm" icon={HistoryIcon} onClick={onOpenRuns}>
          {t('runs')}
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
          aria-label={t('deleteScheduleAria')}
        />
      </div>
    </li>
  );
}

/**
 * スケジュールパネル本体。
 *
 * @param search 検索語（親コンポーネントから渡される）。スケジュール名または
 *   SQL 文に部分一致するものだけへ一覧を絞り込む。
 */
export function SchedulesPanel({ search }: { search: string }) {
  const t = useT(scheduleDict);
  const { datasources } = useDatasources();
  const list = useSchedules();
  // saved query ピッカー用。Alert パネルと同じキャッシュキーを使い、
  // 両パネルを行き来しても再フェッチが重複しないようにする。
  const savedQueriesQuery = useQuery({
    queryKey: ['saved-queries', 'list'],
    queryFn: () => listSavedQueries(),
  });
  // savedQueriesQuery.data ?? [] は毎レンダーで新しい配列を作ってしまい、依存配列に
  // 渡すと後続の useMemo が常に再計算されてしまうため、この参照自体もメモ化する。
  const savedQueries = useMemo(() => savedQueriesQuery.data ?? [], [savedQueriesQuery.data]);
  // schedule.savedQueryId → SavedQuery の解決マップ。一覧表示（クエリ名、
  // 実行先データソースの表示）と検索の両方で使う。
  const savedQueryById = useMemo(
    () => new Map(savedQueries.map((q) => [q.id, q] as const)),
    [savedQueries],
  );
  const create = useCreateSchedule();
  const update = useUpdateSchedule();
  const remove = useDeleteSchedule();
  const runNow = useRunScheduleNow();

  // Modal state. `formOpen` covers both create (editing === null) and edit.
  // フォームモーダルの開閉状態。editing が null なら新規作成モード、
  // 非 null なら編集対象のスケジュールを保持する編集モードとして扱う。
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Schedule | null>(null);
  // 直前の作成/更新リクエストでサーバーから返ったバリデーションエラー。
  const [serverError, setServerError] = useState<FormError | null>(null);
  // 実行履歴モーダルの表示対象。null なら非表示。
  const [runsFor, setRunsFor] = useState<Schedule | null>(null);
  // 削除確認モーダルの対象。null なら非表示。
  const [pendingDelete, setPendingDelete] = useState<Schedule | null>(null);
  // 「今すぐ実行」処理中のスケジュール id。行ごとの Run now ボタンの disabled 制御に使う。
  const [runningId, setRunningId] = useState<string | null>(null);

  const now = new Date();

  // 「New schedule」ボタン押下時: 新規作成モードでフォームモーダルを開く。
  const openCreate = () => {
    setEditing(null);
    setServerError(null);
    setFormOpen(true);
  };
  // 行の「Edit」ボタン押下時: 対象スケジュールを編集モードとしてフォームモーダルを開く。
  const openEdit = (schedule: Schedule) => {
    setEditing(schedule);
    setServerError(null);
    setFormOpen(true);
  };
  // フォームモーダルを閉じる（キャンセル、または保存成功時に呼ばれる）。関連 state をリセットする。
  const closeForm = () => {
    setFormOpen(false);
    setEditing(null);
    setServerError(null);
  };

  // 検索語でスケジュール一覧を絞り込み、名前順に並べ替えた結果をメモ化する。
  // schedule 自体は SQL 文を持たないため、名前に加えて参照先の保存済みクエリの
  // 名前/SQL 文（大小文字無視）のいずれかに検索語を含むものも対象にする。
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const items = list.data ?? [];
    const matched = q
      ? items.filter((s) => {
          if (s.name.toLowerCase().includes(q)) return true;
          const sq = savedQueryById.get(s.savedQueryId);
          return (
            (sq?.name.toLowerCase().includes(q) ?? false) ||
            (sq?.statement.toLowerCase().includes(q) ?? false)
          );
        })
      : items;
    return [...matched].sort((a, b) => a.name.localeCompare(b.name));
  }, [list.data, search, savedQueryById]);

  // 「今すぐ実行」を実行するハンドラー。実行中は runningId をセットしてボタンを無効化し、
  // 成功時は実行履歴モーダルを開いて経過を確認できるようにする。既に実行中（409）の場合は
  // 専用のエラーメッセージを出す。
  const runSchedule = (schedule: Schedule) => {
    setRunningId(schedule.id);
    runNow.mutate(schedule.id, {
      onSuccess: () => {
        toast.info(t('runStartedTitle'), t('runStartedBody', { name: schedule.name }));
        setRunsFor(schedule);
      },
      onError: (error) => {
        if (error instanceof ApiClientError && error.status === 409) {
          toast.error(t('alreadyRunningTitle'), t('alreadyRunningBody'));
        } else {
          toast.error(t('runFailedTitle'), t('runFailedBody'));
        }
      },
      onSettled: () => setRunningId(null),
    });
  };

  // 有効/無効トグルスイッチのハンドラー。enabled フィールドのみを更新する部分更新リクエスト。
  const toggleEnabled = (schedule: Schedule) => {
    update.mutate(
      { id: schedule.id, body: { enabled: !schedule.enabled } },
      { onError: () => toast.error(t('updateFailed'), t('couldNotReachServer')) },
    );
  };

  // 一覧取得中はローディング表示のみを返す。
  if (list.isPending) {
    return (
      <div className="flex items-center justify-center gap-2 py-8 font-mono text-2xs text-ink-subtle">
        <Spinner size={14} /> {t('loading')}
      </div>
    );
  }

  // 取得エラー時の空状態表示。
  if (list.isError) {
    return (
      <EmptyState
        icon={CalendarClock}
        title={t('couldntLoadSchedules')}
        description={t('serverDidntRespond')}
        compact
      />
    );
  }

  return (
    <div className="flex flex-col">
      {/* 新規スケジュール作成ボタン。押すと create モードでフォームモーダルを開く。
          参照できる保存済みクエリが 1 件も無い場合は、まずクエリを保存してもらう必要が
          あるため無効化する（AlertsPanel と同じ導線）。 */}
      <div className="px-3 pb-2">
        <Button
          variant="default"
          size="sm"
          icon={Plus}
          onClick={openCreate}
          className="w-full justify-center"
          disabled={savedQueries.length === 0}
        >
          {t('newSchedule')}
        </Button>
      </div>

      {/* 一覧本体: 絞り込み結果が 0 件なら空状態、そうでなければ各行を描画する。 */}
      {filtered.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title={search.trim() ? t('noMatches') : t('noSchedules')}
          description={
            search.trim()
              ? t('tryDifferentSearchTerm')
              : savedQueries.length === 0
                ? t('saveQueryFirstHint')
                : t('createScheduleHint')
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
              datasources={datasources}
              savedQuery={savedQueryById.get(schedule.savedQueryId)}
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

      {/* 作成と編集のフォームモーダル。schedule=editing の有無でモードが切り替わる。
          作成/更新それぞれの成功時にトースト通知＋モーダルを閉じ、失敗時は
          formatApiError でサーバーエラーをフォーム用に整形して serverError にセットする。 */}
      <ScheduleFormModal
        open={formOpen}
        schedule={editing}
        datasources={datasources}
        savedQueries={savedQueries}
        submitting={create.isPending || update.isPending}
        serverError={serverError}
        onClose={closeForm}
        onCreate={(body) => {
          setServerError(null);
          create.mutate(body, {
            onSuccess: (created) => {
              toast.success(
                t('scheduleCreatedTitle'),
                t('scheduleCreatedBody', { name: created.name }),
              );
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
                toast.success(
                  t('scheduleUpdatedTitle'),
                  t('scheduleUpdatedBody', { name: updated.name }),
                );
                closeForm();
              },
              onError: (error) => setServerError(formatApiError(error)),
            },
          );
        }}
      />

      {/* 実行履歴モーダル。runsFor が null であれば非表示（Modal 側の open props で判定）。 */}
      <ScheduleRunsModal schedule={runsFor} onClose={() => setRunsFor(null)} />

      {/* 削除確認モーダル。Delete 押下で実際の削除 mutation を実行し、
          成功/失敗どちらの場合もモーダルは閉じる（楽観的に閉じてトーストで結果を伝える）。 */}
      <Modal
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title={t('deleteScheduleTitle')}
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
                    onSuccess: () => toast.info(t('deleted'), t('scheduleRemoved')),
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
