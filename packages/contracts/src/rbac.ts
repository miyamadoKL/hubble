import { z } from 'zod';

/**
 * RBAC の権限名。Phase A では /api/me への露出のみ。強制は Phase B。
 */
export const permissionSchema = z.enum(['query.write', 'query.killAny', 'queries.viewAll']);
/** 権限の推論型。 */
export type Permission = z.infer<typeof permissionSchema>;
