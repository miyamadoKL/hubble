import { z } from 'zod';

/**
 * RBAC の権限名。Phase A では /api/me への露出のみ。強制は Phase B。
 */
export const permissionSchema = z.enum([
  'query.write',
  'query.killAny',
  'queries.viewAll',
  'audit.view',
  // AI アシスタント（/api/ai/*）の利用権限。
  'ai.use',
]);
/** 権限の推論型。 */
export type Permission = z.infer<typeof permissionSchema>;

/**
 * read-only ロールが書き込み文を実行しようとしたときのエラーコード（HTTP 403）。
 */
export const WRITE_NOT_ALLOWED = 'WRITE_NOT_ALLOWED';
