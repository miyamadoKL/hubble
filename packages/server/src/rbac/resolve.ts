/**
 * principal からロールを解決する。
 */
import type { Permission } from '@hubble/contracts';
import type { LoadedRbac, ResolvedRole, RbacAssignment } from './types';

/** rbac.yaml が無いときの組み込みロール（従来挙動と等価）。 */
export const UNRESTRICTED_ROLE_NAME = 'unrestricted';

// rbac.yaml が無い運用でも AI アシスタントを使えるように ai.use を含める。
// provider が off のときは POST /api/ai/assist が 501 になるため安全。
const UNRESTRICTED_PERMISSIONS: ReadonlySet<Permission> = new Set(['query.write', 'ai.use']);

/** 組み込み unrestricted ロール（全員に割り当て）。 */
export function builtInUnrestrictedRole(): ResolvedRole {
  return {
    name: UNRESTRICTED_ROLE_NAME,
    permissions: UNRESTRICTED_PERMISSIONS,
  };
}

function assignmentMatches(
  assignment: RbacAssignment,
  principal: { user: string; email?: string; groups?: string[] },
): boolean {
  if (assignment.email !== undefined) {
    if (principal.email === undefined) return false;
    return principal.email.toLowerCase() === assignment.email.toLowerCase();
  }
  if (assignment.user !== undefined) {
    return principal.user === assignment.user;
  }
  if (assignment.emailDomain !== undefined) {
    if (principal.email === undefined) return false;
    const at = principal.email.lastIndexOf('@');
    if (at < 0) return false;
    const domain = principal.email.slice(at + 1);
    return domain.toLowerCase() === assignment.emailDomain.toLowerCase();
  }
  if (assignment.group !== undefined) {
    const groups = principal.groups ?? [];
    if (groups.length === 0) return false;
    const target = assignment.group.toLowerCase();
    return groups.some((group) => group.toLowerCase() === target);
  }
  return false;
}

/**
 * ロード済み RBAC 設定と principal から解決済みロールを返す。
 * @param rbac - 起動時に読み込んだ RBAC 設定。
 * @param principal - 認証済み principal（role 未付与）。
 */
export function resolveRoleForPrincipal(
  rbac: LoadedRbac,
  principal: { user: string; email?: string; groups?: string[] },
): ResolvedRole {
  for (const assignment of rbac.assignments) {
    if (!assignmentMatches(assignment, principal)) continue;
    const role = rbac.roles.get(assignment.role);
    if (role === undefined) {
      throw new Error(`rbac: assignment references undefined role '${assignment.role}'`);
    }
    return {
      name: assignment.role,
      permissions: role.permissions,
      ...(role.guard !== undefined ? { guard: role.guard } : {}),
      ...(role.datasources !== undefined ? { datasources: role.datasources } : {}),
    };
  }

  const fallback = rbac.roles.get(rbac.defaultRole);
  if (fallback === undefined) {
    throw new Error(`rbac: defaultRole '${rbac.defaultRole}' is not defined`);
  }
  return {
    name: rbac.defaultRole,
    permissions: fallback.permissions,
    ...(fallback.guard !== undefined ? { guard: fallback.guard } : {}),
    ...(fallback.datasources !== undefined ? { datasources: fallback.datasources } : {}),
  };
}
