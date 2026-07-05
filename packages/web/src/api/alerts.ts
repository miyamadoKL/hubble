/**
 * Alert CRUD と手動評価の API クライアント。
 * 各関数は apiFetch の薄いラッパーで、@hubble/contracts の zod スキーマで検証する。
 */
import { z } from 'zod';
import {
  alertEvalResponseSchema,
  alertSchema,
  apiRoutes,
  type Alert,
  type AlertEvalResponse,
  type CreateAlertRequest,
  type UpdateAlertRequest,
} from '@hubble/contracts';
import { apiFetch } from './client';

const alertListSchema = z.array(alertSchema);
const okSchema = z.object({ ok: z.boolean() });

/** `GET /api/alerts` で Alert 一覧を取得する。 */
export function listAlerts(): Promise<Alert[]> {
  return apiFetch(alertListSchema, apiRoutes.alerts());
}

/** `POST /api/alerts` で Alert を作成する。 */
export function createAlert(body: CreateAlertRequest): Promise<Alert> {
  return apiFetch(alertSchema, apiRoutes.alerts(), { method: 'POST', body });
}

/** `PUT /api/alerts/:id` で Alert を更新する。 */
export function updateAlert(id: string, body: UpdateAlertRequest): Promise<Alert> {
  return apiFetch(alertSchema, apiRoutes.alert(id), { method: 'PUT', body });
}

/** `DELETE /api/alerts/:id` で Alert を削除する。 */
export async function deleteAlert(id: string): Promise<boolean> {
  const res = await apiFetch(okSchema, apiRoutes.alert(id), { method: 'DELETE' });
  return res.ok;
}

/** `POST /api/alerts/:id/eval` で Alert を手動評価する。 */
export function evalAlertNow(id: string): Promise<AlertEvalResponse> {
  return apiFetch(alertEvalResponseSchema, apiRoutes.alertEval(id), { method: 'POST' });
}
