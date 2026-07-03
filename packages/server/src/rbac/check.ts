/**
 * RBAC 権限チェックの小さなヘルパー。
 */
import type { Permission } from '@hubble/contracts';
import type { PrincipalIdentity } from '../auth/principal';
import type { ResolvedRole } from './types';

/** principal が query.write を持つか。 */
export function hasQueryWrite(role: ResolvedRole): boolean {
  return role.permissions.has('query.write' as Permission);
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
