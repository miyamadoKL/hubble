/**
 * principal からロールを解決する。
 */
import type { LoadedRbac, ResolvedRole, RbacAssignment } from './types';

function assignmentMatches(
  assignment: RbacAssignment,
  principal: { user: string; email?: string; groups?: string[] },
): boolean {
  if (assignment.email !== undefined) {
    if (principal.email === undefined) return false;
    return principal.email.toLowerCase() === assignment.email.toLowerCase();
  }
  if (assignment.user !== undefined) {
    return principal.user.toLowerCase() === assignment.user.toLowerCase();
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
      datasources: role.datasources,
      ...(role.guard !== undefined ? { guard: role.guard } : {}),
    };
  }

  const fallback = rbac.roles.get(rbac.defaultRole);
  if (fallback === undefined) {
    throw new Error(`rbac: defaultRole '${rbac.defaultRole}' is not defined`);
  }
  return {
    name: rbac.defaultRole,
    permissions: fallback.permissions,
    datasources: fallback.datasources,
    ...(fallback.guard !== undefined ? { guard: fallback.guard } : {}),
  };
}
