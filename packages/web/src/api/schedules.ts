// Schedule CRUD + run fetchers (Query Scheduling feature). Thin wrappers over
// `apiFetch`, each validating against the contract schema. The Schedules panel
// and its hooks drive these; refetch policy (intervals, invalidation) lives in
// the hooks, not here.

import { z } from 'zod';
import {
  scheduleSchema,
  scheduleRunsResponseSchema,
  apiRoutes,
  type Schedule,
  type ScheduleRun,
  type CreateScheduleRequest,
  type UpdateScheduleRequest,
} from '@hubble/contracts';
import { apiFetch } from './client';

/** `GET /api/schedules` returns a bare array (server: scheduleRoutes). */
const scheduleListSchema = z.array(scheduleSchema);
const runResponseSchema = z.object({ runId: z.string().min(1) });
const okSchema = z.object({ ok: z.boolean() });

/** List all schedules (newest activity surfaced via `lastRun`). */
export function listSchedules(): Promise<Schedule[]> {
  return apiFetch(scheduleListSchema, apiRoutes.schedules());
}

/** Create a schedule (`POST`, 201) and return the persisted record. */
export function createSchedule(body: CreateScheduleRequest): Promise<Schedule> {
  return apiFetch(scheduleSchema, apiRoutes.schedules(), { method: 'POST', body });
}

/** Partially update a schedule (`PATCH`); changed statement/cron is re-validated server-side. */
export function updateSchedule(id: string, body: UpdateScheduleRequest): Promise<Schedule> {
  return apiFetch(scheduleSchema, apiRoutes.schedule(id), { method: 'PATCH', body });
}

/** Delete a schedule. Resolves true on success. */
export async function deleteSchedule(id: string): Promise<boolean> {
  const res = await apiFetch(okSchema, apiRoutes.schedule(id), { method: 'DELETE' });
  return res.ok;
}

/** Trigger an immediate run (`POST .../run`, 202). Returns the new run id. */
export async function runScheduleNow(id: string): Promise<string> {
  const res = await apiFetch(runResponseSchema, apiRoutes.scheduleRun(id), { method: 'POST' });
  return res.runId;
}

/** List a schedule's runs, newest first (`GET .../runs?limit=`). */
export function listScheduleRuns(id: string, limit?: number): Promise<ScheduleRun[]> {
  return apiFetch(scheduleRunsResponseSchema, apiRoutes.scheduleRuns(id), {
    query: limit ? { limit } : undefined,
  }).then((r) => r.items);
}
