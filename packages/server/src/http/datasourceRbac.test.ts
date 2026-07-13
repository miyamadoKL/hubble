/**
 * role.datasources による datasource 露出制限の統合テスト。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { apiRoutes, datasourcesResponseSchema } from '@hubble/contracts';
import { createTestContext } from '../test/harness';
import type { FakeScenario } from '../test/fakeTrino';

const VALIDATE_OK: FakeScenario = {
  match: 'EXPLAIN (TYPE VALIDATE)',
  pages: [{ columns: [{ name: 'result', type: 'boolean' }], data: [[true]] }],
};

const nationScenario: FakeScenario = {
  match: 'nation',
  pages: [
    {
      columns: [{ name: 'n', type: 'bigint' }],
      data: [[1]],
      state: 'FINISHED',
    },
  ],
};

/** 1 行 1 ページで truncated を作るシナリオ。 */
function manyRowScenario(rowCount: number): FakeScenario {
  const columns = [{ name: 'id', type: 'bigint' }];
  const pages = Array.from({ length: rowCount }, (_, i) => ({
    columns: i === 0 ? columns : undefined,
    data: [[i]],
    state: i === rowCount - 1 ? 'FINISHED' : 'RUNNING',
  }));
  return { match: 'many', trinoId: 'many', pages };
}

const catalogScenario: FakeScenario = {
  match: 'system.metadata.catalogs',
  trinoId: 'catalogs',
  pages: [
    {
      columns: [{ name: 'catalog_name', type: 'varchar' }],
      data: [['tpch']],
      state: 'FINISHED',
    },
  ],
};

function writeDatasources(dir: string): void {
  writeFileSync(
    join(dir, 'datasources.yaml'),
    `datasources:
  - id: trino-prod
    type: trino
    displayName: Production Trino
    username: trino-user
    passwordEnv: TRINO_SECRET
    baseUrl: http://trino:8080
  - id: mysql-analytics
    type: mysql
    displayName: Analytics MySQL
    username: mysql-user
    host: mysql.internal
    database: analytics
`,
    'utf8',
  );
}

function writeRbac(dir: string): void {
  writeFileSync(
    join(dir, 'rbac.yaml'),
    `roles:
  trino-only:
    permissions: [query.write]
    datasources: [trino-prod]
  none:
    permissions: [query.write]
    datasources: []
assignments:
  - user: trino-user
    role: trino-only
  - user: blocked-user
    role: none
defaultRole: none
`,
    'utf8',
  );
}

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

function rbacDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'hubble-ds-rbac-'));
  writeDatasources(tempDir);
  writeRbac(tempDir);
  return tempDir;
}

function proxyHeaders(user: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-forwarded-user': user,
    'x-forwarded-email': `${user}@example.com`,
  };
}

describe('role.datasources enforcement', () => {
  it('filters GET /api/datasources by role allowlist', async () => {
    const ctx = await createTestContext({
      cwd: rbacDir(),
      env: { AUTH_MODE: 'proxy', AUTH_USER_MAPPING: 'user', TRINO_SECRET: 'hidden' },
      remoteAddress: () => '127.0.0.1',
    });

    const allowed = await ctx.app.request(apiRoutes.datasources(), {
      headers: proxyHeaders('trino-user'),
    });
    expect(allowed.status).toBe(200);
    const allowedBody = datasourcesResponseSchema.parse(await allowed.json());
    expect(allowedBody.datasources.map((ds) => ds.id)).toEqual(['trino-prod']);

    const denied = await ctx.app.request(apiRoutes.datasources(), {
      headers: proxyHeaders('blocked-user'),
    });
    expect(denied.status).toBe(200);
    const deniedBody = datasourcesResponseSchema.parse(await denied.json());
    expect(deniedBody.datasources).toEqual([]);

    await ctx.services.shutdown();
  });

  it('returns 404 for query and estimate on unauthorized datasourceId', async () => {
    const ctx = await createTestContext({
      cwd: rbacDir(),
      env: { AUTH_MODE: 'proxy', AUTH_USER_MAPPING: 'user', TRINO_SECRET: 'hidden' },
      remoteAddress: () => '127.0.0.1',
      scenarios: [nationScenario],
    });

    const queryRes = await ctx.app.request('/api/queries', {
      method: 'POST',
      headers: proxyHeaders('trino-user'),
      body: JSON.stringify({
        statement: 'SELECT 1',
        datasourceId: 'mysql-analytics',
      }),
    });
    expect(queryRes.status).toBe(404);

    const estimateRes = await ctx.app.request('/api/queries/estimate', {
      method: 'POST',
      headers: proxyHeaders('trino-user'),
      body: JSON.stringify({
        statement: 'SELECT nationkey FROM tpch.tiny.nation',
        datasourceId: 'mysql-analytics',
      }),
    });
    expect(estimateRes.status).toBe(404);

    const allowedRes = await ctx.app.request('/api/queries', {
      method: 'POST',
      headers: proxyHeaders('trino-user'),
      body: JSON.stringify({
        statement: 'SELECT 1',
        datasourceId: 'trino-prod',
      }),
    });
    expect(allowedRes.status).toBe(202);

    await ctx.services.shutdown();
  });

  it('returns 404 for estimate on unauthorized datasourceId even when Query Guard is off', async () => {
    const ctx = await createTestContext({
      cwd: rbacDir(),
      env: {
        AUTH_MODE: 'proxy',
        AUTH_USER_MAPPING: 'user',
        TRINO_SECRET: 'hidden',
        QUERY_GUARD_MODE: 'off',
      },
      remoteAddress: () => '127.0.0.1',
    });

    const estimateRes = await ctx.app.request('/api/queries/estimate', {
      method: 'POST',
      headers: proxyHeaders('trino-user'),
      body: JSON.stringify({
        statement: 'SELECT 1',
        datasourceId: 'mysql-analytics',
      }),
    });
    expect(estimateRes.status).toBe(404);

    await ctx.services.shutdown();
  });

  it('returns 404 for metadata routes on unauthorized datasource', async () => {
    const ctx = await createTestContext({
      cwd: rbacDir(),
      env: { AUTH_MODE: 'proxy', AUTH_USER_MAPPING: 'user', TRINO_SECRET: 'hidden' },
      remoteAddress: () => '127.0.0.1',
      scenarios: [catalogScenario],
      configOverrides: { defaults: { catalog: 'tpch', schema: 'tiny', limit: 1000 } },
    });

    const legacyAllowed = await ctx.app.request('/api/catalogs', {
      headers: proxyHeaders('trino-user'),
    });
    expect(legacyAllowed.status).toBe(200);

    const legacyDenied = await ctx.app.request('/api/catalogs', {
      headers: proxyHeaders('blocked-user'),
    });
    expect(legacyDenied.status).toBe(404);

    const scoped = await ctx.app.request('/api/datasources/mysql-analytics/catalogs', {
      headers: proxyHeaders('trino-user'),
    });
    expect(scoped.status).toBe(404);

    const allowed = await ctx.app.request('/api/datasources/trino-prod/catalogs', {
      headers: proxyHeaders('trino-user'),
    });
    expect(allowed.status).toBe(200);

    await ctx.services.shutdown();
  });

  it('rejects schedule creation for unauthorized datasourceId', async () => {
    const ctx = await createTestContext({
      cwd: rbacDir(),
      env: { AUTH_MODE: 'proxy', AUTH_USER_MAPPING: 'user', TRINO_SECRET: 'hidden' },
      remoteAddress: () => '127.0.0.1',
      scenarios: [VALIDATE_OK],
    });

    const denied = await ctx.app.request('/api/schedules', {
      method: 'POST',
      headers: proxyHeaders('trino-user'),
      body: JSON.stringify({
        name: 'bad',
        statement: 'SELECT 1',
        cron: '* * * * *',
        datasourceId: 'mysql-analytics',
      }),
    });
    expect(denied.status).toBe(404);

    const allowed = await ctx.app.request('/api/schedules', {
      method: 'POST',
      headers: proxyHeaders('trino-user'),
      body: JSON.stringify({
        name: 'ok',
        statement: 'SELECT 1',
        cron: '* * * * *',
        datasourceId: 'trino-prod',
      }),
    });
    expect(allowed.status).toBe(201);

    await ctx.services.shutdown();
  });

  it('returns 404 for CSV download re-exec when role no longer allows the query datasource', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hubble-ds-rbac-csv-'));
    try {
      writeDatasources(dir);
      writeFileSync(
        join(dir, 'rbac.yaml'),
        `roles:
  none:
    permissions: [query.write]
    datasources: []
assignments:
  - user: runner
    role: none
defaultRole: none
`,
        'utf8',
      );
      const ctx = await createTestContext({
        cwd: dir,
        env: { AUTH_MODE: 'proxy', AUTH_USER_MAPPING: 'user', TRINO_SECRET: 'hidden' },
        remoteAddress: () => '127.0.0.1',
        scenarios: [manyRowScenario(12)],
      });
      const exec = ctx.services.registry.submit({
        statement: 'SELECT * FROM many',
        ctx: { user: 'runner', catalog: 'tpch', schema: 'tiny' },
        datasourceId: 'trino-prod',
        maxRows: 3,
      });
      await exec.settled;
      expect(exec.truncated).toBe(true);

      const postsBefore = ctx.fake.requests.filter((r) => r.method === 'POST').length;
      const csvRes = await ctx.app.request(`/api/queries/${exec.queryId}/download.csv`, {
        headers: proxyHeaders('runner'),
      });
      expect(csvRes.status).toBe(404);
      expect(ctx.fake.requests.filter((r) => r.method === 'POST').length).toBe(postsBefore);

      await ctx.services.shutdown();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allows disable-only PATCH but rejects re-enable when datasource access is lost', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hubble-ds-rbac-patch-'));
    try {
      writeDatasources(dir);
      writeFileSync(
        join(dir, 'rbac.yaml'),
        `roles:
  none:
    permissions: [query.write]
    datasources: []
assignments:
  - user: runner
    role: none
defaultRole: none
`,
        'utf8',
      );
      const ctx = await createTestContext({
        cwd: dir,
        env: { AUTH_MODE: 'proxy', AUTH_USER_MAPPING: 'user', TRINO_SECRET: 'hidden' },
        remoteAddress: () => '127.0.0.1',
        scenarios: [VALIDATE_OK],
      });
      const record = await ctx.services.schedules.create('runner', {
        name: 'legacy',
        statement: 'SELECT 1',
        cron: '* * * * *',
        enabled: false,
        datasourceId: 'trino-prod',

        principalSnapshot: { user: 'runner' },
      });
      const disableRes = await ctx.app.request(`/api/schedules/${record.id}`, {
        method: 'PATCH',
        headers: proxyHeaders('runner'),
        body: JSON.stringify({ enabled: false }),
      });
      expect(disableRes.status).toBe(200);

      const enableRes = await ctx.app.request(`/api/schedules/${record.id}`, {
        method: 'PATCH',
        headers: proxyHeaders('runner'),
        body: JSON.stringify({ enabled: true }),
      });
      expect(enableRes.status).toBe(404);
      await ctx.services.shutdown();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns 404 for manual schedule run when owner role cannot access datasourceId', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hubble-ds-rbac-run-'));
    try {
      writeDatasources(dir);
      writeFileSync(
        join(dir, 'rbac.yaml'),
        `roles:
  none:
    permissions: [query.write]
    datasources: []
assignments:
  - user: runner
    role: none
defaultRole: none
`,
        'utf8',
      );
      const ctx = await createTestContext({
        cwd: dir,
        env: { AUTH_MODE: 'proxy', AUTH_USER_MAPPING: 'user', TRINO_SECRET: 'hidden' },
        remoteAddress: () => '127.0.0.1',
        scenarios: [VALIDATE_OK],
      });
      const record = await ctx.services.schedules.create('runner', {
        name: 'legacy',
        statement: 'SELECT 1',
        cron: '* * * * *',
        datasourceId: 'trino-prod',

        principalSnapshot: { user: 'runner' },
      });
      const runRes = await ctx.app.request(`/api/schedules/${record.id}/run`, {
        method: 'POST',
        headers: proxyHeaders('runner'),
      });
      expect(runRes.status).toBe(404);
      await ctx.services.shutdown();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
