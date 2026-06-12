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

const schedulesKey = ['schedules', 'list'] as const;
const runsKey = (id: string) => ['schedules', 'runs', id] as const;

/** Poll the schedule list every 15s while the panel is shown (running → success). */
const LIST_REFETCH_MS = 15_000;
/** Poll a schedule's runs every 4s while at least one run is still running. */
const RUNS_ACTIVE_REFETCH_MS = 4_000;

export function useSchedules(enabled = true): UseQueryResult<Schedule[]> {
  return useQuery({
    queryKey: schedulesKey,
    queryFn: listSchedules,
    enabled,
    refetchInterval: enabled ? LIST_REFETCH_MS : false,
    refetchOnMount: 'always',
  });
}

export function useScheduleRuns(id: string | null, limit = 50): UseQueryResult<ScheduleRun[]> {
  return useQuery({
    queryKey: runsKey(id ?? ''),
    queryFn: () => listScheduleRuns(id!, limit),
    enabled: id !== null,
    // Speed up polling while a run is active so success/failure surfaces quickly.
    refetchInterval: (query) => {
      const data = query.state.data as ScheduleRun[] | undefined;
      const active = data?.some((r) => r.status === 'running');
      return active ? RUNS_ACTIVE_REFETCH_MS : false;
    },
    refetchOnMount: 'always',
  });
}

/** Invalidate both the list and a schedule's runs (after a run / edit). */
function useScheduleInvalidation() {
  const client = useQueryClient();
  return (id?: string) => {
    void client.invalidateQueries({ queryKey: schedulesKey });
    if (id) void client.invalidateQueries({ queryKey: runsKey(id) });
  };
}

export function useCreateSchedule() {
  const invalidate = useScheduleInvalidation();
  return useMutation({
    mutationFn: (body: CreateScheduleRequest) => createSchedule(body),
    onSuccess: () => invalidate(),
  });
}

export function useUpdateSchedule() {
  const invalidate = useScheduleInvalidation();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateScheduleRequest }) =>
      updateSchedule(id, body),
    onSuccess: (_data, vars) => invalidate(vars.id),
  });
}

export function useDeleteSchedule() {
  const invalidate = useScheduleInvalidation();
  return useMutation({
    mutationFn: (id: string) => deleteSchedule(id),
    onSuccess: () => invalidate(),
  });
}

export function useRunScheduleNow() {
  const invalidate = useScheduleInvalidation();
  return useMutation({
    mutationFn: (id: string) => runScheduleNow(id),
    onSuccess: (_runId, id) => invalidate(id),
  });
}
