import { describe, expect, test } from 'vitest';
import { quoteIdentifier, relativeTableName, selectTemplate } from './tableName';

describe('quoteIdentifier', () => {
  test('leaves plain lowercase identifiers unquoted', () => {
    expect(quoteIdentifier('orders')).toBe('orders');
    expect(quoteIdentifier('order_items')).toBe('order_items');
    expect(quoteIdentifier('_x1')).toBe('_x1');
  });

  test('quotes mixed-case, spaced, or leading-digit names', () => {
    expect(quoteIdentifier('Orders')).toBe('"Orders"');
    expect(quoteIdentifier('my table')).toBe('"my table"');
    expect(quoteIdentifier('1st')).toBe('"1st"');
  });

  test('escapes embedded double quotes by doubling', () => {
    expect(quoteIdentifier('a"b')).toBe('"a""b"');
  });
});

describe('relativeTableName', () => {
  const ref = { catalog: 'tpch', schema: 'sf1', name: 'orders' };

  test('bare name when catalog + schema both match context', () => {
    expect(relativeTableName(ref, { catalog: 'tpch', schema: 'sf1' })).toBe('orders');
  });

  test('schema.table when only the catalog matches', () => {
    expect(relativeTableName(ref, { catalog: 'tpch', schema: 'sf10' })).toBe('sf1.orders');
  });

  test('fully-qualified when the catalog differs', () => {
    expect(relativeTableName(ref, { catalog: 'tpcds', schema: 'sf1' })).toBe('tpch.sf1.orders');
  });

  test('fully-qualified when the context is empty', () => {
    expect(relativeTableName(ref, {})).toBe('tpch.sf1.orders');
  });

  test('quotes each qualified part as needed', () => {
    const odd = { catalog: 'My Cat', schema: 'S 1', name: 'Tbl' };
    expect(relativeTableName(odd, {})).toBe('"My Cat"."S 1"."Tbl"');
    expect(relativeTableName(odd, { catalog: 'My Cat', schema: 'other' })).toBe('"S 1"."Tbl"');
  });
});

describe('selectTemplate', () => {
  const ref = { catalog: 'tpch', schema: 'sf1', name: 'orders' };

  test('lists known columns and qualifies relative to context', () => {
    const sql = selectTemplate(ref, ['orderkey', 'totalprice'], { catalog: 'tpch', schema: 'sf1' });
    expect(sql).toBe('SELECT orderkey, totalprice\nFROM orders\nLIMIT 100');
  });

  test('falls back to * when no columns are known', () => {
    const sql = selectTemplate(ref, [], { catalog: 'tpcds', schema: 'sf1' });
    expect(sql).toBe('SELECT *\nFROM tpch.sf1.orders\nLIMIT 100');
  });

  test('honors a custom limit and quotes odd columns', () => {
    const sql = selectTemplate(ref, ['Order Key'], { catalog: 'tpch', schema: 'sf1' }, 25);
    expect(sql).toBe('SELECT "Order Key"\nFROM orders\nLIMIT 25');
  });
});
