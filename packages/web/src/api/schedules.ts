// Schedule CRUD + run fetchers (Query Scheduling feature). Thin wrappers over
// `apiFetch`, each validating against the contract schema. The Schedules panel
// and its hooks drive these; refetch policy (intervals, invalidation) lives in
// the hooks, not here.
//
// クエリスケジュール（Query Scheduling 機能）の CRUD 操作と、
// スケジュールの手動実行と実行履歴取得を行うための API クライアントファイル。
// 各関数は apiFetch の薄いラッパーであり、レスポンスを @hubble/contracts の
// zod スキーマで検証する。どのくらいの間隔で再取得するか（ポーリング）や
// キャッシュ無効化のタイミングといったポリシーは、Schedules パネル側の
// カスタムフックが担当し、このファイルには持たせない。

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
// 一覧取得レスポンス用のスキーマ。サーバー（scheduleRoutes）はオブジェクトで
// ラップせず、スケジュールの配列をそのまま返す。
const scheduleListSchema = z.array(scheduleSchema);
// 手動実行トリガー時のレスポンス用スキーマ。発行された実行 ID のみを含む。
const runResponseSchema = z.object({ runId: z.string().min(1) });
// 削除など成否のみを返す操作向けの共通スキーマ。
const okSchema = z.object({ ok: z.boolean() });

/**
 * List all schedules (newest activity surfaced via `lastRun`).
 * `GET /api/schedules` を呼び出し、登録済みスケジュールの一覧を取得する。
 * 各スケジュールの `lastRun` フィールドから直近の実行状況が分かる。
 * @returns スケジュールの配列。
 * @throws {ApiClientError} リクエスト失敗時、またはレスポンスがスキーマに一致しない場合。
 */
export function listSchedules(): Promise<Schedule[]> {
  return apiFetch(scheduleListSchema, apiRoutes.schedules());
}

/**
 * Create a schedule (`POST`, 201) and return the persisted record.
 * `POST /api/schedules` を呼び出し、新規スケジュールを作成する。
 * 成功時のステータスコードは 201。cron 式とSQL文はサーバー側でも検証される。
 * @param body 作成するスケジュールの内容（CreateScheduleRequest）。
 * @returns 永続化されたスケジュール（サーバー採番の ID を含む）。
 * @throws {ApiClientError} バリデーションエラー（不正な cron 式等）とリクエスト失敗時、
 *                           またはレスポンスがスキーマに一致しない場合。
 */
export function createSchedule(body: CreateScheduleRequest): Promise<Schedule> {
  return apiFetch(scheduleSchema, apiRoutes.schedules(), { method: 'POST', body });
}

/**
 * Partially update a schedule (`PATCH`); changed statement/cron is re-validated server-side.
 * `PATCH /api/schedules/:id` を呼び出し、スケジュールの一部フィールドのみを更新する。
 * SQL文や cron 式が変更された場合はサーバー側で再度バリデーションが行われる。
 * @param id   更新対象のスケジュール ID。
 * @param body 更新内容（部分更新、UpdateScheduleRequest）。
 * @returns 更新後のスケジュール。
 * @throws {ApiClientError} バリデーションエラー、存在しない ID、リクエスト失敗時、
 *                           またはレスポンスがスキーマに一致しない場合。
 */
export function updateSchedule(id: string, body: UpdateScheduleRequest): Promise<Schedule> {
  return apiFetch(scheduleSchema, apiRoutes.schedule(id), { method: 'PATCH', body });
}

/**
 * Delete a schedule. Resolves true on success.
 * `DELETE /api/schedules/:id` を呼び出し、指定のスケジュールを削除する。
 * @param id 削除対象のスケジュール ID。
 * @returns 削除に成功した場合 true。
 * @throws {ApiClientError} リクエスト失敗時、またはレスポンスがスキーマに一致しない場合。
 */
export async function deleteSchedule(id: string): Promise<boolean> {
  // サーバーからは { ok: boolean } が返るので、その ok フィールドのみを取り出す。
  const res = await apiFetch(okSchema, apiRoutes.schedule(id), { method: 'DELETE' });
  return res.ok;
}

/**
 * Trigger an immediate run (`POST .../run`, 202). Returns the new run id.
 * `POST /api/schedules/:id/run` を呼び出し、スケジュールを cron 待ちせず
 * 即座に1回だけ実行させる。サーバーは実行を非同期で受け付け、202 を返す。
 * @param id 実行対象のスケジュール ID。
 * @returns 新しく発行された実行（run）の ID。
 * @throws {ApiClientError} リクエスト失敗時、またはレスポンスがスキーマに一致しない場合。
 */
export async function runScheduleNow(id: string): Promise<string> {
  const res = await apiFetch(runResponseSchema, apiRoutes.scheduleRun(id), { method: 'POST' });
  return res.runId;
}

/**
 * List a schedule's runs, newest first (`GET .../runs?limit=`).
 * `GET /api/schedules/:id/runs` を呼び出し、指定スケジュールの実行履歴を
 * 新しい順に取得する。
 * @param id    対象のスケジュール ID。
 * @param limit 取得件数の上限。省略時はサーバー側のデフォルト件数。
 * @returns スケジュール実行履歴（ScheduleRun）の配列。
 * @throws {ApiClientError} リクエスト失敗時、またはレスポンスがスキーマに一致しない場合。
 */
export function listScheduleRuns(id: string, limit?: number): Promise<ScheduleRun[]> {
  return apiFetch(scheduleRunsResponseSchema, apiRoutes.scheduleRuns(id), {
    query: limit ? { limit } : undefined,
    // レスポンスはページング envelope（{ items, ... }）なので、items 配列のみを取り出す。
  }).then((r) => r.items);
}
