import { describe, it, expect } from 'vitest';
import {
  catalogsResponseSchema,
  schemasResponseSchema,
  sampleRowsResponseSchema,
  tableDetailSchema,
  tablesResponseSchema,
} from '@hubble/contracts';
import { createTestContext } from '../test/harness';
import type { FakeScenario } from '../test/fakeTrino';

const scenarios: FakeScenario[] = [
  {
    match: 'system.metadata.catalogs',
    trinoId: 'catalogs',
    pages: [
      {
        columns: [{ name: 'catalog_name', type: 'varchar' }],
        data: [['tpch'], ['mysql']],
        state: 'FINISHED',
      },
    ],
  },
  {
    match: 'information_schema.schemata',
    trinoId: 'schemas',
    pages: [
      {
        columns: [{ name: 'schema_name', type: 'varchar' }],
        data: [['tiny'], ['sf1']],
        state: 'FINISHED',
      },
    ],
  },
  {
    match: 'information_schema.tables',
    trinoId: 'tables',
    pages: [
      {
        columns: [
          { name: 'table_name', type: 'varchar' },
          { name: 'table_type', type: 'varchar' },
        ],
        data: [
          ['nation', 'BASE TABLE'],
          ['orders', 'BASE TABLE'],
        ],
        state: 'FINISHED',
      },
    ],
  },
  {
    match: 'information_schema.columns',
    trinoId: 'columns',
    pages: [
      {
        columns: [
          { name: 'column_name', type: 'varchar' },
          { name: 'data_type', type: 'varchar' },
          { name: 'comment', type: 'varchar' },
        ],
        data: [
          ['nationkey', 'bigint', null],
          ['name', 'varchar(25)', 'the name'],
        ],
        state: 'FINISHED',
      },
    ],
  },
  {
    match: 'LIMIT 10',
    trinoId: 'sample',
    pages: [
      {
        columns: [{ name: 'nationkey', type: 'bigint' }],
        data: [[0], [1]],
        state: 'FINISHED',
      },
    ],
  },
];

describe('metadata endpoints', () => {
  it('does not expose unscoped metadata routes', async () => {
    const ctx = await createTestContext({ scenarios });
    const legacyRequests = [
      { path: '/api/catalogs', method: 'GET' },
      { path: '/api/catalogs/tpch/schemas', method: 'GET' },
      { path: '/api/catalogs/tpch/schemas/tiny/tables', method: 'GET' },
      { path: '/api/catalogs/tpch/schemas/tiny/tables/nation', method: 'GET' },
      { path: '/api/catalogs/tpch/schemas/tiny/tables/nation/sample', method: 'GET' },
      { path: '/api/metadata/refresh', method: 'POST' },
    ] as const;
    for (const request of legacyRequests) {
      const response = await ctx.app.request(request.path, {
        method: request.method,
        ...(request.method === 'POST'
          ? {
              headers: { 'content-type': 'application/json' },
              body: '{}',
            }
          : {}),
      });
      expect(response.status).toBe(404);
    }
  });

  it('serves cache on the second catalogs call', async () => {
    const ctx = await createTestContext({ scenarios });
    const path = `/api/datasources/${ctx.services.defaultDatasourceId}/catalogs`;
    await ctx.app.request(path);
    const second = catalogsResponseSchema.parse(await (await ctx.app.request(path)).json());
    expect(second.source).toBe('cache');
  });

  it('serves schemas, tables, table detail, and samples on scoped routes', async () => {
    const ctx = await createTestContext({ scenarios });
    const base = `/api/datasources/${ctx.services.defaultDatasourceId}/catalogs`;

    const schemas = schemasResponseSchema.parse(
      await (await ctx.app.request(`${base}/tpch/schemas`)).json(),
    );
    expect(schemas.items.map((schema) => schema.name)).toEqual(['tiny', 'sf1']);

    const tables = tablesResponseSchema.parse(
      await (await ctx.app.request(`${base}/tpch/schemas/tiny/tables`)).json(),
    );
    expect(tables.items[0]).toEqual({ name: 'nation', type: 'BASE TABLE' });

    const detail = tableDetailSchema.parse(
      await (await ctx.app.request(`${base}/tpch/schemas/tiny/tables/nation`)).json(),
    );
    expect(detail.columns).toEqual([
      { name: 'nationkey', type: 'bigint' },
      { name: 'name', type: 'varchar(25)', comment: 'the name' },
    ]);

    const sample = sampleRowsResponseSchema.parse(
      await (await ctx.app.request(`${base}/tpch/schemas/tiny/tables/nation/sample`)).json(),
    );
    expect(sample.rows).toEqual([[0], [1]]);
    expect(sample.source).toBe('live');
    await ctx.services.shutdown();
  });

  it('GET /api/datasources/:id/catalogs returns datasource-scoped metadata', async () => {
    const ctx = await createTestContext({ scenarios });
    const res = await ctx.app.request(
      `/api/datasources/${ctx.services.defaultDatasourceId}/catalogs`,
    );
    expect(res.status).toBe(200);
    const body = catalogsResponseSchema.parse(await res.json());
    expect(body.items.map((c) => c.name)).toEqual(['tpch', 'mysql']);
    await ctx.services.shutdown();
  });

  it('returns 404 for unknown datasource on scoped metadata route', async () => {
    const ctx = await createTestContext({ scenarios });
    const res = await ctx.app.request('/api/datasources/unknown-ds/catalogs');
    expect(res.status).toBe(404);
    await ctx.services.shutdown();
  });

  it('POST /api/datasources/:id/metadata/refresh re-fetches the selected datasource', async () => {
    const ctx = await createTestContext({ scenarios });
    await ctx.app.request(`/api/datasources/${ctx.services.defaultDatasourceId}/catalogs`);
    const before = ctx.fake.requests.filter((r) => r.method === 'POST').length;
    const datasourceId = ctx.services.defaultDatasourceId;
    const res = await ctx.app.request(`/api/datasources/${datasourceId}/metadata/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, datasourceId });
    const after = ctx.fake.requests.filter((r) => r.method === 'POST').length;
    expect(after).toBeGreaterThan(before);
  });
});

describe('metadata principal impersonation', () => {
  const ssoHeaders = (email: string) => ({ 'x-forwarded-email': email });

  it('sends X-Trino-User as the request principal for catalogs', async () => {
    const ctx = await createTestContext({
      env: { AUTH_MODE: 'proxy' },
      remoteAddress: () => '127.0.0.1',
      scenarios,
    });
    await ctx.app.request(`/api/datasources/${ctx.services.defaultDatasourceId}/catalogs`, {
      headers: ssoHeaders('alice@corp.com'),
    });
    const metaReq = ctx.fake.requests.find(
      (r) => r.headers['x-trino-source'] === 'hubble-metadata',
    );
    expect(metaReq?.headers['x-trino-user']).toBe('alice');
  });

  it('keeps separate metadata caches per principal', async () => {
    const ctx = await createTestContext({
      env: { AUTH_MODE: 'proxy' },
      remoteAddress: () => '127.0.0.1',
      scenarios,
    });
    const path = `/api/datasources/${ctx.services.defaultDatasourceId}/catalogs`;
    await ctx.app.request(path, { headers: ssoHeaders('alice@corp.com') });
    const alicePosts = ctx.fake.requests.filter((r) => r.method === 'POST').length;

    await ctx.app.request(path, { headers: ssoHeaders('bob@corp.com') });
    const bobPosts = ctx.fake.requests.filter((r) => r.method === 'POST').length;
    expect(bobPosts).toBeGreaterThan(alicePosts);

    await ctx.app.request(path, { headers: ssoHeaders('alice@corp.com') });
    const aliceAgainPosts = ctx.fake.requests.filter((r) => r.method === 'POST').length;
    expect(aliceAgainPosts).toBe(bobPosts);
  });
});
