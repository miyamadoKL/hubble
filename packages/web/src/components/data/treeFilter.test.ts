// テスト対象: ./treeFilter.ts の matchesNeedle / filterByNeedle / expandedForFilter。
// SchemaTree の検索フィルタが (1) 大文字小文字を無視した部分一致で絞り込むこと、
// (2) マッチしたテーブルを含むカタログ/スキーマだけを自動展開すること、
// (3) 未ロードのブランチには手を出さないことを検証する。

import { describe, expect, test } from 'vitest';
import {
  expandedForFilter,
  filterByNeedle,
  matchesNeedle,
  schemaKey,
  type LoadedTree,
} from './treeFilter';

// テスト用の「既読み込みツリー」フィクスチャ。
// tpch カタログは sf1/sf10 の両スキーマともテーブル一覧まで読み込み済み、
// analytics カタログはスキーマ一覧のみ読み込み済みで reporting のテーブル一覧は未読み込み
// （＝フィルタが到達できない未ロードブランチのケースを表現している）。
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
    // 検索文字列が空のときは常に true（未フィルタ状態）。
    expect(matchesNeedle('orders', '')).toBe(true);
  });
  test('case-insensitive substring', () => {
    // 大文字小文字を無視した部分一致で判定する。
    expect(matchesNeedle('LineItem', 'item')).toBe(true);
    expect(matchesNeedle('orders', 'cust')).toBe(false);
  });
});

describe('filterByNeedle', () => {
  const items = [{ name: 'orders' }, { name: 'customer' }, { name: 'lineitem' }];

  test('returns all items for an empty needle', () => {
    // needle が空なら一覧全体をそのまま返す。
    expect(filterByNeedle(items, (i) => i.name, '')).toHaveLength(3);
  });

  test('keeps only matching names', () => {
    // マッチする name を持つ要素だけが残る。
    expect(filterByNeedle(items, (i) => i.name, 'cust')).toEqual([{ name: 'customer' }]);
  });
});

describe('expandedForFilter', () => {
  test('returns the explicit set unchanged when there is no needle', () => {
    // needle なしなら自動展開せず、手動展開集合をそのまま返す。
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
    // 同一カタログ内の複数スキーマそれぞれでマッチすれば、両方が自動展開される。
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
    // 手動展開済みのキー（analytics）は自動展開の対象外でも維持される。
    const result = expandedForFilter(new Set(['analytics']), 'nation', tree());
    expect(result.has('analytics')).toBe(true); // kept
    expect(result.has(schemaKey('tpch', 'sf10'))).toBe(true); // auto (nation)
  });

  test('no match leaves the set as just the explicit entries', () => {
    // マッチが1件もない needle では、自動展開は増えず手動展開集合だけが残る。
    const result = expandedForFilter(new Set(['tpch']), 'zzz_nope', tree());
    expect([...result]).toEqual(['tpch']);
  });
});
