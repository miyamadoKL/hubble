import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadRbac } from './loader';
import { UNRESTRICTED_ROLE_NAME } from './resolve';

function writeRbac(dir: string, body: string): string {
  const path = join(dir, 'rbac.yaml');
  writeFileSync(path, body, 'utf8');
  return path;
}

const validYaml = `roles:
  admin:
    permissions: [query.write, query.killAny, queries.viewAll]
  member:
    permissions: []
    guard:
      maxScanBytes: 50000000000
      onUnknown: block
assignments:
  - email: alice@example.com
    role: admin
  - user: local-dev
    role: admin
  - emailDomain: example.com
    role: member
defaultRole: member
`;

describe('loadRbac', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'hubble-rbac-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('loads roles, assignments, and defaultRole from YAML', () => {
    const path = writeRbac(tempDir, validYaml);
    const rbac = loadRbac({ env: { RBAC_PATH: path }, cwd: tempDir });

    expect(rbac.defaultRole).toBe('member');
    expect(rbac.assignments).toHaveLength(3);
    expect(rbac.roles.get('admin')?.permissions).toEqual(
      new Set(['query.write', 'query.killAny', 'queries.viewAll']),
    );
    expect(rbac.roles.get('member')?.guard).toEqual({
      maxScanBytes: 50000000000,
      onUnknown: 'block',
    });
  });

  it('falls back to unrestricted when no rbac file exists', () => {
    const rbac = loadRbac({ env: {}, cwd: tempDir });
    expect(rbac.defaultRole).toBe(UNRESTRICTED_ROLE_NAME);
    expect(rbac.roles.get(UNRESTRICTED_ROLE_NAME)?.permissions).toEqual(new Set(['query.write']));
    expect(rbac.assignments).toEqual([]);
  });

  it('rejects duplicate permissions in a role', () => {
    const path = writeRbac(
      tempDir,
      `roles:
  admin:
    permissions: [query.write, query.write]
assignments: []
defaultRole: admin
`,
    );
    expect(() => loadRbac({ env: { RBAC_PATH: path }, cwd: tempDir })).toThrow(
      /permissions\[1\]: duplicate permission/,
    );
  });

  it('rejects assignments that reference an undefined role', () => {
    const path = writeRbac(
      tempDir,
      `roles:
  admin:
    permissions: [query.write]
assignments:
  - user: alice
    role: missing
defaultRole: admin
`,
    );
    expect(() => loadRbac({ env: { RBAC_PATH: path }, cwd: tempDir })).toThrow(
      /assignments\[0\]\.role 'missing' is not defined in roles/,
    );
  });

  it('rejects assignments with multiple match keys', () => {
    const path = writeRbac(
      tempDir,
      `roles:
  admin:
    permissions: [query.write]
assignments:
  - email: a@b.com
    user: alice
    role: admin
defaultRole: admin
`,
    );
    expect(() => loadRbac({ env: { RBAC_PATH: path }, cwd: tempDir })).toThrow(
      /exactly one of email, user, emailDomain, or group must be set/,
    );
  });

  it('rejects invalid role names', () => {
    const path = writeRbac(
      tempDir,
      `roles:
  Admin:
    permissions: [query.write]
assignments: []
defaultRole: Admin
`,
    );
    expect(() => loadRbac({ env: { RBAC_PATH: path }, cwd: tempDir })).toThrow(
      /must match \/\^\[a-z\]/,
    );
  });

  it('rejects unknown permission values', () => {
    const path = writeRbac(
      tempDir,
      `roles:
  admin:
    permissions: [query.write, query.admin]
assignments: []
defaultRole: admin
`,
    );
    expect(() => loadRbac({ env: { RBAC_PATH: path }, cwd: tempDir })).toThrow(
      /Invalid enum value|permissions/,
    );
  });

  it('errors when RBAC_PATH points to a missing file', () => {
    expect(() =>
      loadRbac({ env: { RBAC_PATH: join(tempDir, 'missing.yaml') }, cwd: tempDir }),
    ).toThrow(/rbac file .* cannot be read/);
  });

  it('loads role datasources allowlist including wildcard and empty array', () => {
    const path = writeRbac(
      tempDir,
      `roles:
  all:
    permissions: [query.write]
    datasources: ['*']
  trino-only:
    permissions: [query.write]
    datasources: [trino-prod]
  none:
    permissions: []
    datasources: []
  legacy:
    permissions: []
assignments: []
defaultRole: all
`,
    );
    const rbac = loadRbac({ env: { RBAC_PATH: path }, cwd: tempDir });
    expect(rbac.roles.get('all')?.datasources).toEqual(['*']);
    expect(rbac.roles.get('trino-only')?.datasources).toEqual(['trino-prod']);
    expect(rbac.roles.get('none')?.datasources).toEqual([]);
    expect(rbac.roles.get('legacy')?.datasources).toBeUndefined();
  });

  it('rejects null datasources in role definition', () => {
    const path = writeRbac(
      tempDir,
      `roles:
  bad:
    permissions: [query.write]
    datasources: null
assignments: []
defaultRole: bad
`,
    );
    expect(() => loadRbac({ env: { RBAC_PATH: path }, cwd: tempDir })).toThrow(
      /roles\.bad\.datasources/,
    );
  });

  it('rejects invalid datasource ids in role datasources', () => {
    const path = writeRbac(
      tempDir,
      `roles:
  bad:
    permissions: [query.write]
    datasources: [Trino-Prod]
assignments: []
defaultRole: bad
`,
    );
    expect(() => loadRbac({ env: { RBAC_PATH: path }, cwd: tempDir })).toThrow(
      /roles\.bad\.datasources\[0\]/,
    );
  });

  it('rejects duplicate datasource entries in role datasources', () => {
    const path = writeRbac(
      tempDir,
      `roles:
  bad:
    permissions: [query.write]
    datasources: [trino-prod, trino-prod]
assignments: []
defaultRole: bad
`,
    );
    expect(() => loadRbac({ env: { RBAC_PATH: path }, cwd: tempDir })).toThrow(
      /duplicate datasource 'trino-prod'/,
    );
  });
});
