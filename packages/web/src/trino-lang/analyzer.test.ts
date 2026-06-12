import { describe, expect, test } from 'vitest';
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

function mockSource(): MetadataSource {
  return {
    listCatalogs: async () => ['tpch'],
    listSchemas: async () => ['tiny'],
    listTables: async () => ['orders', 'customer'],
    getTable: async (_c, _s, t) => (t === 'orders' ? ORDERS : undefined),
  };
}

/** Build a SchemaCache and synchronously pre-populate it (await warmers). */
async function warmedCache(): Promise<SchemaCache> {
  const cache = new SchemaCache(mockSource());
  cache.warmCatalogs();
  cache.warmTables('tpch', 'tiny');
  await cache.resolveTable(new TableReference('tpch', 'tiny', 'orders'));
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

  test('never throws on malformed input', () => {
    const cache = new SchemaCache(mockSource());
    expect(() => collectCompletions({ sql: 'SELECT ( FROM', offset: 8, cache })).not.toThrow();
  });
});
