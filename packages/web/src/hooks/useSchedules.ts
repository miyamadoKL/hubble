// --- ファイル概要（日本語） ---
// クエリスケジューリング機能（Query Scheduling）向けの TanStack Query hooks 一式。
// スケジュール（Schedule）の一覧取得、作成、更新、削除、即時実行、および各スケジュールの
// 実行履歴（ScheduleRun）取得を、../api/schedules の API 関数（listSchedules 等）を
// 呼び出す形でラップしている。一覧はパネル表示中ポーリングすることで、サーバー側で
// 実行中（running）だったスケジュールが成功（success）に変わったときも手動リロードなしで
// 画面に反映される。実行履歴側は「実行中の run が存在する間だけ」ポーリング間隔を
// 短くすることで、完了検知を速めつつ無駄なポーリングを避けている。
// 各 mutation（作成、更新、削除、即時実行）は成功時に関連するキャッシュキーを invalidate し、
// 一覧と履歴の表示を常に最新の状態に保つ。

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type {
  Schedule,
  ScheduleRun,
  CreateScheduleRequest,
  UpdateScheduleRequest,
} from '@hubble/contracts';
import {
  listSchedules,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  runScheduleNow,
  listScheduleRuns,
} from '../api/schedules';

/**
 * TanStack Query hooks for the Query Scheduling feature. The list polls while the
 * panel is mounted so a `running` run flips to `success` on screen without a
 * manual refresh; the runs query polls a little faster while a run is in flight.
 * All mutations invalidate the relevant keys so the UI stays consistent.
 */

// スケジュール一覧のキャッシュキー。
const schedulesKey = ['schedules', 'list'] as const;
// 特定スケジュールの実行履歴のキャッシュキー。スケジュール ID ごとに独立したキーとする。
const runsKey = (id: string) => ['schedules', 'runs', id] as const;

/** Poll the schedule list every 15s while the panel is shown (running → success). */
/** スケジュール一覧を15秒ごとにポーリングする間隔。パネル表示中のみ有効（running → success の反映用）。 */
const LIST_REFETCH_MS = 15_000;
/** Poll a schedule's runs every 4s while at least one run is still running. */
/** 実行履歴を4秒ごとにポーリングする間隔。少なくとも1件の run が running 状態の間のみ有効。 */
const RUNS_ACTIVE_REFETCH_MS = 4_000;

/**
 * スケジュール一覧を取得する hook。listSchedules（../api/schedules）を呼び出す。
 *
 * @param enabled - false を渡すとクエリ自体を無効化し、ポーリングも止める
 *   （スケジュール管理パネルが非表示のときなどに使う想定）。デフォルトは true。
 * @returns UseQueryResult<Schedule[]>。enabled が true の間は LIST_REFETCH_MS（15秒）
 *   おきに自動再取得され、実行中のスケジュールが完了した際も画面が自動更新される。
 *   refetchOnMount: 'always' により、パネルが再マウントされるたびに必ず最新状態を取り直す。
 */
export function useSchedules(enabled = true): UseQueryResult<Schedule[]> {
  return useQuery({
    queryKey: schedulesKey,
    queryFn: listSchedules,
    enabled,
    refetchInterval: enabled ? LIST_REFETCH_MS : false,
    refetchOnMount: 'always',
  });
}

/**
 * 指定したスケジュールの実行履歴（ScheduleRun の配列）を取得する hook。
 * listScheduleRuns（../api/schedules）を呼び出す。
 *
 * @param id - 対象スケジュールの ID。null の場合はクエリを無効化する（未選択状態）。
 * @param limit - 取得する履歴の最大件数。デフォルトは50件。
 * @returns UseQueryResult<ScheduleRun[]>。取得したデータの中に status が 'running' の
 *   run が1件でもあれば RUNS_ACTIVE_REFETCH_MS（4秒）間隔でポーリングを継続し、
 *   実行が完了（success/failure）した時点でポーリングを止める（refetchInterval が false を返す）。
 *   refetchOnMount: 'always' により選択スケジュールが切り替わるたびに最新の履歴を取得する。
 */
export function useScheduleRuns(id: string | null, limit = 50): UseQueryResult<ScheduleRun[]> {
  return useQuery({
    queryKey: runsKey(id ?? ''),
    queryFn: () => listScheduleRuns(id!, limit),
    enabled: id !== null,
    // Speed up polling while a run is active so success/failure surfaces quickly.
    // 現在のキャッシュデータを見て、running 状態の run が1件でもあればポーリング間隔を
    // 短く保ち、なければポーリングを停止する（false を返すと refetchInterval は無効化される）。
    refetchInterval: (query) => {
      const data = query.state.data as ScheduleRun[] | undefined;
      const active = data?.some((r) => r.status === 'running');
      return active ? RUNS_ACTIVE_REFETCH_MS : false;
    },
    refetchOnMount: 'always',
  });
}

/** Invalidate both the list and a schedule's runs (after a run / edit). */
/**
 * スケジュール一覧のキャッシュ、および（id を指定した場合は）そのスケジュールの実行履歴
 * キャッシュを invalidate する関数を返す内部ヘルパー hook。作成、更新、削除、即時実行の
 * 各 mutation の onSuccess から呼び出され、mutation 後に UI が最新状態を再取得するよう促す。
 */
function useScheduleInvalidation() {
  const client = useQueryClient();
  return (id?: string) => {
    void client.invalidateQueries({ queryKey: schedulesKey });
    if (id) void client.invalidateQueries({ queryKey: runsKey(id) });
  };
}

/**
 * 新規スケジュールを作成する mutation hook。createSchedule（../api/schedules）を呼び出し、
 * 成功時にスケジュール一覧のキャッシュを invalidate して画面に反映させる。
 */
export function useCreateSchedule() {
  const invalidate = useScheduleInvalidation();
  return useMutation({
    mutationFn: (body: CreateScheduleRequest) => createSchedule(body),
    onSuccess: () => invalidate(),
  });
}

/**
 * 既存スケジュールを更新する mutation hook。updateSchedule（../api/schedules）を呼び出し、
 * 成功時にスケジュール一覧と、更新対象スケジュールの実行履歴の両方を invalidate する。
 */
export function useUpdateSchedule() {
  const invalidate = useScheduleInvalidation();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateScheduleRequest }) =>
      updateSchedule(id, body),
    onSuccess: (_data, vars) => invalidate(vars.id),
  });
}

/**
 * スケジュールを削除する mutation hook。deleteSchedule（../api/schedules）を呼び出し、
 * 成功時にスケジュール一覧のキャッシュを invalidate する。
 */
export function useDeleteSchedule() {
  const invalidate = useScheduleInvalidation();
  return useMutation({
    mutationFn: (id: string) => deleteSchedule(id),
    onSuccess: () => invalidate(),
  });
}

/**
 * スケジュールを即座に（cron 待ちせず）実行する mutation hook。
 * runScheduleNow（../api/schedules）を呼び出し、成功時にスケジュール一覧と該当スケジュールの
 * 実行履歴を invalidate することで、新しい run（初期状態は running）が useScheduleRuns の
 * ポーリングで画面に反映されるようにする。
 */
export function useRunScheduleNow() {
  const invalidate = useScheduleInvalidation();
  return useMutation({
    mutationFn: (id: string) => runScheduleNow(id),
    onSuccess: (_runId, id) => invalidate(id),
  });
}
