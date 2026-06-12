import { describe, expect, test } from 'vitest';
import {
  expandedForFilter,
  filterByNeedle,
  matchesNeedle,
  schemaKey,
  type LoadedTree,
} from './treeFilter';

function tree(): LoadedTree {
  return {
    schemasByCatalog: new Map([
      ['tpch', ['sf1', 'sf10']],
      ['analytics', ['reporting']],
    ]),
    tablesBySchema: new Map([
      [schemaKey('tpch', 'sf1'), ['orders', 'lineitem', 'customer']],
      [schemaKey('tpch', 'sf10'), ['orders', 'nation']],
      // analytics.reporting is *not* loaded — left out of tablesBySchema.
    ]),
  };
}

describe('matchesNeedle', () => {
  test('empty needle matches anything', () => {
    expect(matchesNeedle('orders', '')).toBe(true);
  });
  test('case-insensitive substring', () => {
    expect(matchesNeedle('LineItem', 'item')).toBe(true);
    expect(matchesNeedle('orders', 'cust')).toBe(false);
  });
});

describe('filterByNeedle', () => {
  const items = [{ name: 'orders' }, { name: 'customer' }, { name: 'lineitem' }];

  test('returns all items for an empty needle', () => {
    expect(filterByNeedle(items, (i) => i.name, '')).toHaveLength(3);
  });

  test('keeps only matching names', () => {
    expect(filterByNeedle(items, (i) => i.name, 'cust')).toEqual([{ name: 'customer' }]);
  });
});

describe('expandedForFilter', () => {
  test('returns the explicit set unchanged when there is no needle', () => {
    const explicit = new Set(['tpch']);
    const result = expandedForFilter(explicit, '', tree());
    expect([...result]).toEqual(['tpch']);
  });

  test('auto-expands the catalog + schema of a matched table', () => {
    const result = expandedForFilter(new Set(), 'lineitem', tree());
    // tpch.sf1 contains lineitem → both tpch and tpch::sf1 expand.
    expect(result.has('tpch')).toBe(true);
    expect(result.has(schemaKey('tpch', 'sf1'))).toBe(true);
    // sf10 has no match → not auto-expanded.
    expect(result.has(schemaKey('tpch', 'sf10'))).toBe(false);
  });

  test('matches across multiple schemas of the same catalog', () => {
    const result = expandedForFilter(new Set(), 'orders', tree());
    expect(result.has(schemaKey('tpch', 'sf1'))).toBe(true);
    expect(result.has(schemaKey('tpch', 'sf10'))).toBe(true);
  });

  test('does not reach into unloaded branches', () => {
    // 'reporting' tables aren't loaded, so a needle that would match there can't
    // auto-expand it — and analytics stays collapsed.
    const result = expandedForFilter(new Set(), 'revenue', tree());
    expect(result.has('analytics')).toBe(false);
    expect(result.has(schemaKey('analytics', 'reporting'))).toBe(false);
  });

  test('preserves manually-expanded keys alongside auto-expansion', () => {
    const result = expandedForFilter(new Set(['analytics']), 'nation', tree());
    expect(result.has('analytics')).toBe(true); // kept
    expect(result.has(schemaKey('tpch', 'sf10'))).toBe(true); // auto (nation)
  });

  test('no match leaves the set as just the explicit entries', () => {
    const result = expandedForFilter(new Set(['tpch']), 'zzz_nope', tree());
    expect([...result]).toEqual(['tpch']);
  });
});
