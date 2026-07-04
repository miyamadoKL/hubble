import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { meResponseSchema, estimateResultSchema } from '@hubble/contracts';
import { startFileReload } from '../config/fileReload';
import { createTestContext } from '../test/harness';
import type { FakeScenario } from '../test/fakeTrino';

function ioPlanCell(rows: number, bytes: number): string {
  return JSON.stringify({
    inputTableColumnInfos: [
      {
        table: { catalog: 'tpch', schemaTable: { schema: 'tiny', table: 'nation' } },
        constraint: { none: false, columnConstraints: [] },
        estimate: { outputRowCount: rows, outputSizeInBytes: bytes },
      },
    ],
    estimate: { outputRowCount: rows, outputSizeInBytes: bytes },
  });
}

const nationScenario: FakeScenario = {
  match: 'nation',
  trinoId: 'explain',
  pages: [
    {
      columns: [{ name: 'Query Plan', type: 'varchar' }],
      data: [[ioPlanCell(25, 2734)]],
      state: 'FINISHED',
    },
  ],
};

function memberRbacYaml(guardMaxScanRows: number): string {
  return `roles:
  member:
    permissions: []
    guard:
      maxScanRows: ${guardMaxScanRows}
defaultRole: member
`;
}

describe('services.reloadRbac', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'hubble-rbac-reload-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('reflects rbac changes in GET /api/me on the next request', async () => {
    const rbacPath = join(tempDir, 'rbac.yaml');
    writeFileSync(rbacPath, memberRbacYaml(10_000), 'utf8');
    const ctx = await createTestContext({
      env: { RBAC_PATH: 'rbac.yaml' },
      cwd: tempDir,
    });
    let res = await ctx.app.request('/api/me');
    expect(meResponseSchema.parse(await res.json()).role).toBe('member');

    writeFileSync(
      rbacPath,
      `roles:
  admin:
    permissions: [query.write]
defaultRole: admin
`,
      'utf8',
    );
    await ctx.services.reloadRbac();
    res = await ctx.app.request('/api/me');
    expect(meResponseSchema.parse(await res.json()).role).toBe('admin');
  });

  it('reflects datasource allowlist changes in GET /api/me after reload', async () => {
    writeFileSync(
      join(tempDir, 'datasources.yaml'),
      `datasources:
  - id: trino-prod
    type: trino
    displayName: Production Trino
    username: trino
    baseUrl: http://trino.test
  - id: trino-dev
    type: trino
    displayName: Development Trino
    username: trino
    baseUrl: http://trino.test
`,
      'utf8',
    );
    const rbacPath = join(tempDir, 'rbac.yaml');
    writeFileSync(
      rbacPath,
      `roles:
  analyst:
    permissions: [query.write]
    datasources: [trino-prod]
defaultRole: analyst
`,
      'utf8',
    );
    const ctx = await createTestContext({
      env: { RBAC_PATH: 'rbac.yaml' },
      cwd: tempDir,
    });
    let res = await ctx.app.request('/api/me');
    expect(meResponseSchema.parse(await res.json()).datasources.map((ds) => ds.id)).toEqual([
      'trino-prod',
    ]);

    writeFileSync(
      rbacPath,
      `roles:
  analyst:
    permissions: [query.write]
    datasources: [trino-dev]
defaultRole: analyst
`,
      'utf8',
    );
    await ctx.services.reloadRbac();
    res = await ctx.app.request('/api/me');
    expect(meResponseSchema.parse(await res.json()).datasources.map((ds) => ds.id)).toEqual([
      'trino-dev',
    ]);
  });

  it('keeps current config on invalid YAML and recovers after fix', async () => {
    const rbacPath = join(tempDir, 'rbac.yaml');
    writeFileSync(rbacPath, memberRbacYaml(10_000), 'utf8');
    const errors: unknown[] = [];
    const ctx = await createTestContext({
      env: { RBAC_PATH: 'rbac.yaml' },
      cwd: tempDir,
      reloadLogError: (_m, e) => errors.push(e),
    });
    writeFileSync(rbacPath, 'roles: [{bad', 'utf8');
    await ctx.services.reloadRbac();
    expect(errors).toHaveLength(1);
    let res = await ctx.app.request('/api/me');
    expect(meResponseSchema.parse(await res.json()).role).toBe('member');

    writeFileSync(
      rbacPath,
      `roles:
  operator:
    permissions: [query.write]
defaultRole: operator
`,
      'utf8',
    );
    await ctx.services.reloadRbac();
    res = await ctx.app.request('/api/me');
    expect(meResponseSchema.parse(await res.json()).role).toBe('operator');
  });

  it('activates roles when rbac.yaml is created after unrestricted startup', async () => {
    const ctx = await createTestContext({ cwd: tempDir });
    let res = await ctx.app.request('/api/me');
    expect(meResponseSchema.parse(await res.json()).role).toBe('unrestricted');

    writeFileSync(join(tempDir, 'rbac.yaml'), memberRbacYaml(10_000), 'utf8');
    await ctx.services.reloadRbac();
    res = await ctx.app.request('/api/me');
    expect(meResponseSchema.parse(await res.json()).role).toBe('member');
  });

  it('uses new guard limits after reload (cache key includes guard values)', async () => {
    const rbacPath = join(tempDir, 'rbac.yaml');
    writeFileSync(rbacPath, memberRbacYaml(1_000_000), 'utf8');
    const ctx = await createTestContext({
      scenarios: [nationScenario],
      env: { RBAC_PATH: 'rbac.yaml' },
      cwd: tempDir,
      configOverrides: {
        guard: {
          mode: 'enforce',
          maxScanBytes: 0,
          maxScanRows: 1_000_000,
          onUnknown: 'warn',
          estimateTimeoutMs: 3000,
          cacheTtlSeconds: 300,
          bytesPerSecond: 0,
        },
      },
    });

    const body = {
      statement: 'SELECT * FROM nation',
      catalog: 'tpch',
      schema: 'tiny',
    };
    let res = await ctx.app.request('/api/queries/estimate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(estimateResultSchema.parse(await res.json()).verdict.decision).toBe('allow');

    writeFileSync(rbacPath, memberRbacYaml(10), 'utf8');
    await ctx.services.reloadRbac();

    res = await ctx.app.request('/api/queries/estimate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(estimateResultSchema.parse(await res.json()).verdict.decision).toBe('block');
  });
});

describe('rbac hot-reload via startFileReload', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'hubble-rbac-file-'));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('reloads rbac on SIGHUP', async () => {
    const rbacPath = join(tempDir, 'rbac.yaml');
    writeFileSync(rbacPath, memberRbacYaml(10_000), 'utf8');
    const ctx = await createTestContext({
      env: { RBAC_PATH: 'rbac.yaml' },
      cwd: tempDir,
    });
    writeFileSync(
      rbacPath,
      `roles:
  viewer:
    permissions: []
defaultRole: viewer
`,
      'utf8',
    );
    const handle = startFileReload([{ path: rbacPath, reload: () => ctx.services.reloadRbac() }], {
      intervalSeconds: 0,
    });
    process.emit('SIGHUP');
    await Promise.resolve();
    const res = await ctx.app.request('/api/me');
    expect(meResponseSchema.parse(await res.json()).role).toBe('viewer');
    handle.stop();
  });

  it('fires reload when rbac.yaml appears after unrestricted startup', async () => {
    const ctx = await createTestContext({ cwd: tempDir });
    const rbacPath = join(tempDir, 'rbac.yaml');
    const mtimes = new Map<string, number>();
    const handle = startFileReload([{ path: rbacPath, reload: () => ctx.services.reloadRbac() }], {
      intervalSeconds: 30,
      statImpl: (p) => (mtimes.has(p) ? { mtimeMs: mtimes.get(p)! } : null),
    });
    writeFileSync(rbacPath, memberRbacYaml(10_000), 'utf8');
    mtimes.set(rbacPath, 1000);
    await vi.advanceTimersByTimeAsync(30_000);
    const res = await ctx.app.request('/api/me');
    expect(meResponseSchema.parse(await res.json()).role).toBe('member');
    handle.stop();
  });
});
