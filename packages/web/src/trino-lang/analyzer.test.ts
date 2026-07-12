import { describe, expect, test, vi } from 'vitest';
import { parseStatement, collectCompletions } from './analyzer';
import { SchemaCache } from './sql/SchemaCache';
import TableReference from './schema/TableReference';
import type { MetadataSource, MetadataTable } from './sql/MetadataSource';

const ORDERS: MetadataTable = {
  catalog: 'tpch',
  schema: 'tiny',
  name: 'orders',
  columns: [
    { name: 'orderkey', type: 'bigint' },
    { name: 'custkey', type: 'bigint' },
    { name: 'totalprice', type: 'double' },
  ],
};

const CUSTOMER: MetadataTable = {
  catalog: 'tpch',
  schema: 'tiny',
  name: 'customer',
  columns: [
    { name: 'customer_name', type: 'varchar' },
    { name: 'nationkey', type: 'bigint' },
  ],
};

const LINEITEM: MetadataTable = {
  catalog: 'tpch',
  schema: 'tiny',
  name: 'lineitem',
  columns: [
    { name: 'partkey', type: 'bigint' },
    { name: 'quantity', type: 'double' },
  ],
};

function mockSource(): MetadataSource {
  return {
    listCatalogs: async () => ['tpch'],
    listSchemas: async () => ['tiny'],
    listTables: async () => ['orders', 'customer', 'lineitem'],
    getTable: async (_c, _s, t) => {
      if (t === 'orders') return ORDERS;
      if (t === 'customer') return CUSTOMER;
      if (t === 'lineitem') return LINEITEM;
      return undefined;
    },
  };
}

/** Build a SchemaCache and synchronously pre-populate it (await warmers). */
async function warmedCache(): Promise<SchemaCache> {
  const cache = new SchemaCache(mockSource());
  cache.warmCatalogs();
  cache.warmTables('tpch', 'tiny');
  await cache.resolveTable(new TableReference('tpch', 'tiny', 'orders'));
  await cache.resolveTable(new TableReference('tpch', 'tiny', 'customer'));
  await cache.resolveTable(new TableReference('tpch', 'tiny', 'lineitem'));
  // Let the fire-and-forget warmers settle.
  await new Promise((r) => setTimeout(r, 10));
  return cache;
}

describe('parseStatement — markers', () => {
  test('valid SQL produces no markers', () => {
    expect(parseStatement('SELECT 1').markers).toEqual([]);
    expect(parseStatement('SELECT orderkey FROM tpch.tiny.orders').markers).toEqual([]);
  });

  test('empty input produces no markers', () => {
    expect(parseStatement('   ').markers).toEqual([]);
  });

  test('`SELECT FROM` reports a syntax error at the FROM token', () => {
    const markers = parseStatement('SELECT FROM').markers;
    expect(markers.length).toBeGreaterThan(0);
    const first = markers[0]!;
    expect(first.startLineNumber).toBe(1);
    // `FROM` starts at column 8 (1-based) in "SELECT FROM".
    expect(first.startColumn).toBe(8);
    expect(first.endColumn).toBeGreaterThan(first.startColumn);
    expect(first.message).toMatch(/FROM/);
  });

  test('table-name decorations carry a resolvable TableReference', () => {
    const { descriptors } = parseStatement('SELECT * FROM tpch.tiny.orders', 'tpch', 'tiny');
    expect(descriptors.length).toBe(1);
    expect(descriptors[0]!.tableReference?.fullyQualified).toBe('tpch.tiny.orders');
  });

  test('JOINと入れ子の各query scopeで全relationを保持する', () => {
    const sql = [
      'SELECT * FROM tpch.tiny.orders o',
      'JOIN tpch.tiny.customer c ON o.custkey = c.custkey',
      'WHERE o.orderkey IN (SELECT orderkey FROM tpch.tiny.lineitem)',
    ].join(' ');
    const references = parseStatement(sql, 'tpch', 'tiny').tableReferences;

    expect(references.map((reference) => reference.fullyQualified)).toEqual(
      expect.arrayContaining(['tpch.tiny.orders', 'tpch.tiny.customer', 'tpch.tiny.lineitem']),
    );
  });
});

describe('collectCompletions', () => {
  test('keyword + snippet candidates at the start of a statement', async () => {
    const cache = await warmedCache();
    const items = collectCompletions({
      sql: '',
      offset: 0,
      cache,
      catalog: 'tpch',
      schema: 'tiny',
    });
    const labels = items.map((i) => i.label);
    expect(labels).toContain('select');
    expect(labels).toContain('with');
    // Snippets are offered alongside their trigger keyword.
    expect(items.some((i) => i.kind === 'snippet')).toBe(true);
  });

  test('table candidates after FROM (FQN + context-relative + CTE)', async () => {
    const cache = await warmedCache();
    const sql = 'SELECT * FROM ';
    const items = collectCompletions({
      sql,
      offset: sql.length,
      cache,
      catalog: 'tpch',
      schema: 'tiny',
    });
    const tables = items.filter((i) => i.kind === 'table').map((i) => i.label);
    expect(tables).toContain('tpch.tiny.orders'); // fully-qualified
    expect(tables).toContain('orders'); // context-relative
  });

  test('a trailing-space caret after FROM still yields table candidates', async () => {
    // Regression: an EOF/trailing-space caret must resolve to the phantom token
    // index, not an offset-derived one (which previously produced zero items).
    const cache = await warmedCache();
    const sql = 'SELECT * FROM '; // caret at the very end (offset === length)
    const items = collectCompletions({
      sql,
      offset: sql.length,
      cache,
      catalog: 'tpch',
      schema: 'tiny',
    });
    expect(items.some((i) => i.kind === 'table')).toBe(true);
  });

  test('CTE names are offered as relation candidates', async () => {
    const cache = await warmedCache();
    const sql = 'WITH recent AS (SELECT 1) SELECT * FROM ';
    const items = collectCompletions({
      sql,
      offset: sql.length,
      cache,
      catalog: 'tpch',
      schema: 'tiny',
    });
    expect(items.some((i) => i.kind === 'cte' && i.label === 'recent')).toBe(true);
  });

  test('column candidates come from the in-context referenced table', async () => {
    const cache = await warmedCache();
    // Caret in the select list of a query that references orders.
    const sql = 'SELECT  FROM tpch.tiny.orders';
    const offset = 'SELECT '.length;
    const items = collectCompletions({ sql, offset, cache, catalog: 'tpch', schema: 'tiny' });
    const cols = items.filter((i) => i.kind === 'column').map((i) => i.label);
    expect(cols).toEqual(expect.arrayContaining(['orderkey', 'custkey', 'totalprice']));
    // The "all columns" expansion is offered too.
    expect(items.some((i) => i.kind === 'columnList')).toBe(true);
  });

  test('JOINした全relationのcolumnを補完候補に含める', async () => {
    const cache = await warmedCache();
    const sql = [
      'SELECT  FROM tpch.tiny.orders o',
      'JOIN tpch.tiny.customer c ON o.custkey = c.custkey',
    ].join(' ');
    const items = collectCompletions({
      sql,
      offset: 'SELECT '.length,
      cache,
      catalog: 'tpch',
      schema: 'tiny',
    });
    const columns = items.filter((item) => item.kind === 'column').map((item) => item.label);

    expect(columns).toEqual(expect.arrayContaining(['orderkey', 'customer_name', 'nationkey']));
  });

  test('外側JOINの補完とwarmingへ内側queryだけのrelationを漏らさない', async () => {
    const cache = await warmedCache();
    const warmTable = vi.spyOn(cache, 'warmTable');
    const sql = [
      'SELECT  FROM tpch.tiny.orders o',
      'JOIN tpch.tiny.customer c ON o.custkey = c.custkey',
      'WHERE EXISTS (SELECT 1 FROM tpch.tiny.lineitem l)',
    ].join(' ');
    const items = collectCompletions({
      sql,
      offset: 'SELECT '.length,
      cache,
      catalog: 'tpch',
      schema: 'tiny',
    });
    const columns = items.filter((item) => item.kind === 'column').map((item) => item.label);

    expect(columns).toEqual(expect.arrayContaining(['orderkey', 'customer_name']));
    expect(columns).not.toContain('partkey');
    expect(warmTable.mock.calls.map(([reference]) => reference.tableName)).toEqual(
      expect.arrayContaining(['orders', 'customer']),
    );
    expect(warmTable.mock.calls.map(([reference]) => reference.tableName)).not.toContain(
      'lineitem',
    );
  });

  test('内側queryの補完では自身とancestorのJOIN relationだけを使う', async () => {
    const cache = await warmedCache();
    const sql = [
      'SELECT 1 FROM tpch.tiny.orders o',
      'JOIN tpch.tiny.customer c ON o.custkey = c.custkey',
      'WHERE EXISTS (SELECT  FROM tpch.tiny.lineitem l)',
    ].join(' ');
    const innerSelect = sql.lastIndexOf('SELECT ') + 'SELECT '.length;
    const items = collectCompletions({
      sql,
      offset: innerSelect,
      cache,
      catalog: 'tpch',
      schema: 'tiny',
    });
    const columns = items.filter((item) => item.kind === 'column').map((item) => item.label);

    expect(columns).toEqual(
      expect.arrayContaining(['orderkey', 'customer_name', 'partkey', 'quantity']),
    );
  });

  test('never throws on malformed input', () => {
    const cache = new SchemaCache(mockSource());
    expect(() => collectCompletions({ sql: 'SELECT ( FROM', offset: 8, cache })).not.toThrow();
  });
});
