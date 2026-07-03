/**
 * RBAC 権限チェックの小さなヘルパー。
 */
import type { Permission } from '@hubble/contracts';
import { AppError } from '../errors';
import type { PrincipalIdentity } from '../auth/principal';
import type { ResolvedRole } from './types';

/** principal が指定権限を持つか。 */
export function hasPermission(role: ResolvedRole, permission: Permission): boolean {
  return role.permissions.has(permission);
}

/**
 * 指定権限を持たない principal のリクエストを 403 で拒否する。
 * 持つ場合は何もしない。
 */
export function requirePermission(role: ResolvedRole, permission: Permission): void {
  if (hasPermission(role, permission)) return;
  throw AppError.forbidden(`Missing permission: ${permission}`, 'FORBIDDEN');
}

/** principal が query.write を持つか。 */
export function hasQueryWrite(role: ResolvedRole): boolean {
  return hasPermission(role, 'query.write');
}

/**
 * スケジュール owner から実行時ロール解決用の principal identity を組み立てる。
 * owner に '@' が含まれる場合は email 系 assignment も機能するよう email にも載せる。
 */
export function schedulePrincipalIdentity(owner: string): PrincipalIdentity {
  if (owner.includes('@')) {
    return { user: owner, email: owner };
  }
  return { user: owner };
}
