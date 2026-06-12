import { describe, it, expect } from 'vitest';
import {
  catalogsResponseSchema,
  schemasResponseSchema,
  tablesResponseSchema,
  tableDetailSchema,
  sampleRowsResponseSchema,
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
  it('GET /api/catalogs returns a MetadataResponse<Catalog>', async () => {
    const ctx = await createTestContext({ scenarios });
    const res = await ctx.app.request('/api/catalogs');
    expect(res.status).toBe(200);
    const body = catalogsResponseSchema.parse(await res.json());
    expect(body.items.map((c) => c.name)).toEqual(['tpch', 'mysql']);
    expect(body.source).toBe('live');
    expect(body.stale).toBe(false);
  });

  it('GET schemas/tables/table detail/sample', async () => {
    const ctx = await createTestContext({ scenarios });

    const schemas = schemasResponseSchema.parse(
      await (await ctx.app.request('/api/catalogs/tpch/schemas')).json(),
    );
    expect(schemas.items.map((s) => s.name)).toEqual(['tiny', 'sf1']);

    const tables = tablesResponseSchema.parse(
      await (await ctx.app.request('/api/catalogs/tpch/schemas/tiny/tables')).json(),
    );
    expect(tables.items[0]).toEqual({ name: 'nation', type: 'BASE TABLE' });

    const detailRes = await ctx.app.request('/api/catalogs/tpch/schemas/tiny/tables/nation');
    const detail = tableDetailSchema.parse(await detailRes.json());
    expect(detail.columns).toEqual([
      { name: 'nationkey', type: 'bigint' },
      { name: 'name', type: 'varchar(25)', comment: 'the name' },
    ]);

    const sample = sampleRowsResponseSchema.parse(
      await (await ctx.app.request('/api/catalogs/tpch/schemas/tiny/tables/nation/sample')).json(),
    );
    expect(sample.rows).toEqual([[0], [1]]);
    expect(sample.source).toBe('live');
  });

  it('serves cache on the second catalogs call', async () => {
    const ctx = await createTestContext({ scenarios });
    await ctx.app.request('/api/catalogs');
    const second = catalogsResponseSchema.parse(
      await (await ctx.app.request('/api/catalogs')).json(),
    );
    expect(second.source).toBe('cache');
  });

  it('POST /api/metadata/refresh re-fetches catalogs', async () => {
    const ctx = await createTestContext({ scenarios });
    await ctx.app.request('/api/catalogs');
    const before = ctx.fake.requests.filter((r) => r.method === 'POST').length;
    const res = await ctx.app.request('/api/metadata/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const after = ctx.fake.requests.filter((r) => r.method === 'POST').length;
    expect(after).toBeGreaterThan(before);
  });
});
