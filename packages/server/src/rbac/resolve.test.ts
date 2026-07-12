import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Permission } from '@hubble/contracts';
import { loadRbac } from './loader';
import { resolveRoleForPrincipal, builtInUnrestrictedRole } from './resolve';
import type { LoadedRbac } from './types';

function loadedFromYaml(yaml: string): LoadedRbac {
  const dir = mkdtempSync(join(tmpdir(), 'hubble-rbac-resolve-'));
  const path = join(dir, 'rbac.yaml');
  writeFileSync(path, yaml, 'utf8');
  try {
    return loadRbac({ env: { RBAC_PATH: path }, cwd: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('resolveRoleForPrincipal', () => {
  const rbac = loadedFromYaml(`roles:
  admin:
    permissions: [query.write, query.killAny, queries.viewAll]
  member:
    permissions: []
assignments:
  - email: Alice@Example.COM
    role: admin
  - user: svc-bot
    role: admin
  - emailDomain: corp.com
    role: member
defaultRole: member
`);

  it('matches email case-insensitively', () => {
    const role = resolveRoleForPrincipal(rbac, { user: 'alice', email: 'alice@example.com' });
    expect(role.name).toBe('admin');
    expect([...role.permissions].sort()).toEqual(
      ['query.killAny', 'queries.viewAll', 'query.write'].sort(),
    );
  });

  it('uses the first matching assignment in file order', () => {
    const ordered = loadedFromYaml(`roles:
  a:
    permissions: [query.write]
  b:
    permissions: [query.killAny]
assignments:
  - emailDomain: corp.com
    role: a
  - user: alice
    role: b
defaultRole: a
`);
    const role = resolveRoleForPrincipal(ordered, {
      user: 'alice',
      email: 'alice@corp.com',
    });
    expect(role.name).toBe('a');
  });

  it('matches user key case-insensitively', () => {
    const role = resolveRoleForPrincipal(rbac, { user: 'SVC-BOT' });
    expect(role.name).toBe('admin');
  });

  it('evaluates assignments from higher to lower priority', () => {
    const prioritized = loadedFromYaml(`roles:
  broad:
    permissions: []
  specific:
    permissions: [query.write]
assignments:
  - emailDomain: corp.com
    priority: 0
    role: broad
  - user: alice
    priority: 10
    role: specific
defaultRole: broad
`);
    const role = resolveRoleForPrincipal(prioritized, {
      user: 'alice',
      email: 'alice@corp.com',
    });
    expect(role.name).toBe('specific');
  });

  it('matches emailDomain case-insensitively', () => {
    const role = resolveRoleForPrincipal(rbac, { user: 'bob', email: 'bob@CORP.COM' });
    expect(role.name).toBe('member');
    expect(role.permissions.size).toBe(0);
  });

  it('falls back to defaultRole when nothing matches', () => {
    const role = resolveRoleForPrincipal(rbac, { user: 'stranger', email: 'x@other.org' });
    expect(role.name).toBe('member');
  });

  it('matches group case-insensitively', () => {
    const withGroup = loadedFromYaml(`roles:
  admin:
    permissions: [query.write, query.killAny, queries.viewAll]
  member:
    permissions: []
assignments:
  - group: Admins@Corp.COM
    role: admin
defaultRole: member
`);
    const role = resolveRoleForPrincipal(withGroup, {
      user: 'bob',
      email: 'bob@corp.com',
      groups: ['engineers@corp.com', 'admins@corp.com'],
    });
    expect(role.name).toBe('admin');
  });

  it('does not match group assignments when principal has no groups', () => {
    const withGroup = loadedFromYaml(`roles:
  admin:
    permissions: [query.write]
  member:
    permissions: []
assignments:
  - group: admins@corp.com
    role: admin
defaultRole: member
`);
    const role = resolveRoleForPrincipal(withGroup, { user: 'bob', email: 'bob@corp.com' });
    expect(role.name).toBe('member');
  });

  it('uses the first matching assignment when group and email both match', () => {
    const ordered = loadedFromYaml(`roles:
  email-role:
    permissions: [query.write]
  group-role:
    permissions: [query.killAny]
assignments:
  - email: alice@corp.com
    role: email-role
  - group: admins@corp.com
    role: group-role
defaultRole: email-role
`);
    const role = resolveRoleForPrincipal(ordered, {
      user: 'alice',
      email: 'alice@corp.com',
      groups: ['admins@corp.com'],
    });
    expect(role.name).toBe('email-role');
  });

  it('uses the first matching assignment when group precedes email', () => {
    const ordered = loadedFromYaml(`roles:
  email-role:
    permissions: [query.write]
  group-role:
    permissions: [query.killAny]
assignments:
  - group: admins@corp.com
    role: group-role
  - email: alice@corp.com
    role: email-role
defaultRole: email-role
`);
    const role = resolveRoleForPrincipal(ordered, {
      user: 'alice',
      email: 'alice@corp.com',
      groups: ['admins@corp.com'],
    });
    expect(role.name).toBe('group-role');
  });

  it('builtInUnrestrictedRole matches legacy behavior', () => {
    const role = builtInUnrestrictedRole();
    expect(role.name).toBe('unrestricted');
    expect([...role.permissions].sort()).toEqual<Permission[]>(['ai.use', 'query.write']);
  });

  it('carries datasources allowlist from resolved role definition', () => {
    const withDatasources = loadedFromYaml(`roles:
  trino-only:
    permissions: [query.write]
    datasources: [trino-prod]
  member:
    permissions: []
assignments:
  - user: alice
    role: trino-only
defaultRole: member
`);
    const role = resolveRoleForPrincipal(withDatasources, { user: 'alice' });
    expect(role.datasources).toEqual(['trino-prod']);
  });

  it('resolves role permissions and datasource allowlist together', () => {
    const withDatasources = loadedFromYaml(`roles:
  analyst:
    permissions: [query.write, queries.viewAll]
    datasources: [trino-prod, trino-dev]
  member:
    permissions: []
    datasources: []
assignments:
  - email: alice@corp.com
    role: analyst
defaultRole: member
`);
    const role = resolveRoleForPrincipal(withDatasources, {
      user: 'alice',
      email: 'alice@corp.com',
    });
    expect(role.name).toBe('analyst');
    expect([...role.permissions].sort()).toEqual(['queries.viewAll', 'query.write']);
    expect(role.datasources).toEqual(['trino-prod', 'trino-dev']);
  });
});
