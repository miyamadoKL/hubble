/**
 * RBAC 権限チェックの小さなヘルパー。
 */
import type { Permission } from '@hubble/contracts';
import { AppError } from '../errors';
import type { PrincipalIdentity } from '../auth/principal';
import type { ResolvedDatasource } from '../datasource/types';
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

/** ロールが指定 datasource へアクセス可能か。 */
export function roleAllowsDatasource(role: ResolvedRole, datasourceId: string): boolean {
  const allowlist = role.datasources;
  if (allowlist === undefined) return true;
  if (allowlist.length === 0) return false;
  if (allowlist.includes('*')) return true;
  return allowlist.includes(datasourceId);
}

/**
 * datasource へのアクセスを要求する。拒否時は存在有無を漏らさない 404 NOT_FOUND。
 */
export function requireDatasourceAccess(role: ResolvedRole, datasourceId: string): void {
  if (roleAllowsDatasource(role, datasourceId)) return;
  throw AppError.notFound(`Datasource ${datasourceId} not found`);
}

/** ロールでアクセス可能な datasource だけに絞り込む。 */
export function filterDatasourcesForRole(
  datasources: readonly ResolvedDatasource[],
  role: ResolvedRole,
): ResolvedDatasource[] {
  return datasources.filter((ds) => roleAllowsDatasource(role, ds.id));
}

/**
 * スケジュール owner から実行時ロール解決用の principal identity を組み立てる。
 * 作成時に保存した principal snapshot だけを実行時 identity として使う。
 * 過去レコードに snapshot が無い場合は、owner 文字列から identity を復元せず明示的に拒否する。
 */
export function schedulePrincipalIdentity(
  owner: string,
  snapshot?: PrincipalIdentity | null,
): PrincipalIdentity {
  if (snapshot) return snapshot;
  throw AppError.badRequest(
    `Cannot execute principal-scoped record '${owner}' without a principal snapshot`,
    'PRINCIPAL_SNAPSHOT_REQUIRED',
  );
}
