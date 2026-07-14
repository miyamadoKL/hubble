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
    datasources: ['*']
    guard:
      maxScanRows: ${guardMaxScanRows}
defaultRole: member
`;
}

function roleRbacYaml(role: string): string {
  return `roles:
  ${role}:
    permissions: []
    datasources: ['*']
defaultRole: ${role}
`;
}

function writeTrinoDatasource(dir: string, id: string): void {
  writeFileSync(
    join(dir, 'datasources.yaml'),
    `datasources:
  - id: ${id}
    type: trino
    username: trino
    baseUrl: http://trino.test
`,
    'utf8',
  );
}

describe('services.reloadConfig', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'hubble-config-reload-'));
    writeTrinoDatasource(tempDir, 'trino-old');
    writeFileSync(join(tempDir, 'rbac.yaml'), roleRbacYaml('member'), 'utf8');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('commits rbac and datasource candidates together when both are valid', async () => {
    const ctx = await createTestContext({ cwd: tempDir });
    writeTrinoDatasource(tempDir, 'trino-new');
    writeFileSync(join(tempDir, 'rbac.yaml'), roleRbacYaml('operator'), 'utf8');

    await Promise.all([ctx.services.reloadConfig(), ctx.services.reloadConfig()]);

    expect(ctx.services.rbac.defaultRole).toBe('operator');
    expect(ctx.services.datasources.map((datasource) => datasource.id)).toEqual(['trino-new']);
    expect(ctx.services.defaultDatasourceId).toBe('trino-new');
    await ctx.services.shutdown();
  });

  it('keeps both current generations when the rbac candidate is invalid', async () => {
    const errors: unknown[] = [];
    const ctx = await createTestContext({
      cwd: tempDir,
      reloadLogError: (_message, error) => errors.push(error),
    });
    const oldEngine = ctx.services.engines.get('trino-old');
    writeTrinoDatasource(tempDir, 'trino-new');
    writeFileSync(join(tempDir, 'rbac.yaml'), 'roles: [{bad', 'utf8');

    await Promise.all([ctx.services.reloadConfig(), ctx.services.reloadConfig()]);

    expect(ctx.services.rbac.defaultRole).toBe('member');
    expect(ctx.services.datasources.map((datasource) => datasource.id)).toEqual(['trino-old']);
    expect(ctx.services.engines.get('trino-old')).toBe(oldEngine);
    expect(ctx.services.engines.has('trino-new')).toBe(false);
    expect(errors).toHaveLength(1);
    await ctx.services.shutdown();
  });

  it('keeps both current generations when the datasource candidate is invalid', async () => {
    const errors: unknown[] = [];
    const ctx = await createTestContext({
      cwd: tempDir,
      reloadLogError: (_message, error) => errors.push(error),
    });
    const oldEngine = ctx.services.engines.get('trino-old');
    writeFileSync(join(tempDir, 'rbac.yaml'), roleRbacYaml('operator'), 'utf8');
    writeFileSync(join(tempDir, 'datasources.yaml'), 'datasources: [{bad', 'utf8');

    await ctx.services.reloadConfig();

    expect(ctx.services.rbac.defaultRole).toBe('member');
    expect(ctx.services.datasources.map((datasource) => datasource.id)).toEqual(['trino-old']);
    expect(ctx.services.engines.get('trino-old')).toBe(oldEngine);
    expect(errors).toHaveLength(1);
    await ctx.services.shutdown();
  });

  it('候補 engine の probe が失敗したら両世代を維持する', async () => {
    const errors: unknown[] = [];
    const ctx = await createTestContext({
      cwd: tempDir,
      reloadLogError: (_message, error) => errors.push(error),
    });
    const oldEngine = ctx.services.engines.get('trino-old');
    ctx.fake.setScenarios([
      {
        match: 'SELECT 1',
        error: { message: 'credential rejected', errorType: 'EXTERNAL' },
      },
    ]);
    writeTrinoDatasource(tempDir, 'trino-new');
    writeFileSync(join(tempDir, 'rbac.yaml'), roleRbacYaml('operator'), 'utf8');

    await ctx.services.reloadConfig();

    expect(ctx.services.rbac.defaultRole).toBe('member');
    expect(ctx.services.datasources.map((datasource) => datasource.id)).toEqual(['trino-old']);
    expect(ctx.services.engines.get('trino-old')).toBe(oldEngine);
    expect(ctx.services.engines.has('trino-new')).toBe(false);
    expect(errors).toHaveLength(1);
    await ctx.services.shutdown();
  });

  it('updates only rbac without regenerating an unchanged engine', async () => {
    const ctx = await createTestContext({ cwd: tempDir });
    const oldEngine = ctx.services.engines.get('trino-old')!;
    const close = vi.spyOn(oldEngine, 'close');
    writeFileSync(join(tempDir, 'rbac.yaml'), roleRbacYaml('operator'), 'utf8');

    await ctx.services.reloadConfig();

    expect(ctx.services.rbac.defaultRole).toBe('operator');
    expect(ctx.services.engines.get('trino-old')).toBe(oldEngine);
    expect(close).not.toHaveBeenCalled();
    await ctx.services.shutdown();
  });

  it('keeps the adopted rbac when the default file disappears', async () => {
    const errors: unknown[] = [];
    const ctx = await createTestContext({
      cwd: tempDir,
      reloadLogError: (_message, error) => errors.push(error),
    });
    rmSync(join(tempDir, 'rbac.yaml'));

    await ctx.services.reloadConfig();

    expect(ctx.services.rbac.defaultRole).toBe('member');
    expect(ctx.services.datasources.map((datasource) => datasource.id)).toEqual(['trino-old']);
    expect(errors).toHaveLength(1);
    await ctx.services.shutdown();
  });
});

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
    datasources: ['*']
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
    datasources: ['*']
defaultRole: operator
`,
      'utf8',
    );
    await ctx.services.reloadRbac();
    res = await ctx.app.request('/api/me');
    expect(meResponseSchema.parse(await res.json()).role).toBe('operator');
  });

  it('keeps the adopted default config when rbac.yaml is removed', async () => {
    const rbacPath = join(tempDir, 'rbac.yaml');
    writeFileSync(rbacPath, memberRbacYaml(10_000), 'utf8');
    const errors: unknown[] = [];
    const ctx = await createTestContext({
      cwd: tempDir,
      reloadLogError: (_message, error) => errors.push(error),
    });

    rmSync(rbacPath);
    await ctx.services.reloadRbac();

    const res = await ctx.app.request('/api/me');
    expect(meResponseSchema.parse(await res.json()).role).toBe('member');
    expect(errors).toHaveLength(1);
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
    datasources: ['*']
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
});
