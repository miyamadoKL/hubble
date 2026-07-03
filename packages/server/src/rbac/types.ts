/**
 * 解決済み RBAC 設定の型定義。
 */
import type { GuardMode, GuardOnUnknown, Permission } from '@hubble/contracts';

/** ロールごとの Query Guard 上書き（任意フィールドのみ）。 */
export interface RoleGuardOverrides {
  mode?: GuardMode;
  maxScanBytes?: number;
  maxScanRows?: number;
  onUnknown?: GuardOnUnknown;
}

/** principal に載せる解決済みロール。 */
export interface ResolvedRole {
  name: string;
  permissions: ReadonlySet<Permission>;
  guard?: RoleGuardOverrides;
}

/** YAML の 1 件の割り当てルール（バリデーション済み）。 */
export interface RbacAssignment {
  email?: string;
  user?: string;
  emailDomain?: string;
  role: string;
}

/** ロード済み RBAC 設定（起動時に 1 回読み込み）。 */
export interface LoadedRbac {
  roles: ReadonlyMap<string, { permissions: ReadonlySet<Permission>; guard?: RoleGuardOverrides }>;
  assignments: readonly RbacAssignment[];
  defaultRole: string;
}
