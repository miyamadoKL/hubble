/**
 * /api/me の permissions を参照する小さなヘルパー。
 */
import type { MeResponse, Permission } from '@hubble/contracts';

/** 認証済みユーザーが指定権限を持つか。 */
export function hasPermission(me: MeResponse | undefined, permission: Permission): boolean {
  return me?.permissions.includes(permission) ?? false;
}
