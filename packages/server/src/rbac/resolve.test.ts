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

  it('matches user key exactly', () => {
    const role = resolveRoleForPrincipal(rbac, { user: 'svc-bot' });
    expect(role.name).toBe('admin');
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

  it('builtInUnrestrictedRole matches legacy behavior', () => {
    const role = builtInUnrestrictedRole();
    expect(role.name).toBe('unrestricted');
    expect([...role.permissions]).toEqual<Permission[]>(['query.write']);
  });
});
