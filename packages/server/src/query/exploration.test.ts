/**
 * query/exploration.ts のユニットテスト。
 */
import { describe, expect, it } from 'vitest';
import type { QueryColumn, ResultSearchRequest } from '@hubble/contracts';
import { profileRowsStream, searchRowsStream } from './exploration';

const COLUMNS: QueryColumn[] = [
  { name: 'id', type: 'bigint' },
  { name: 'name', type: 'varchar' },
  { name: 'score', type: 'double' },
];

const ROWS: unknown[][] = [
  [1, 'Alice', 90],
  [2, 'Bob', null],
  [3, 'charlie', 70],
  [4, null, 85],
  [5, 'ALICE', 90],
];

/** 同期配列を AsyncIterable へ変換する（ストリーム経路のテスト用）。 */
async function* asStream(rows: readonly unknown[][]): AsyncGenerator<unknown[]> {
  for (const row of rows) yield [...row];
}

/** 探索リクエストの省略形。 */
function req(partial: Partial<ResultSearchRequest> = {}): ResultSearchRequest {
  return { offset: 0, limit: 100, ...partial };
}

describe('searchRowsStream', () => {
  it('returns all rows when no filters or search', async () => {
    const { rows, totalMatched, totalRows } = await searchRowsStream(COLUMNS, ROWS, req());
    expect(totalMatched).toBe(5);
    expect(totalRows).toBe(5);
    expect(rows).toHaveLength(5);
  });

  it('works over an async row source', async () => {
    const { rows, totalMatched, totalRows } = await searchRowsStream(
      COLUMNS,
      asStream(ROWS),
      req(),
    );
    expect(totalMatched).toBe(5);
    expect(totalRows).toBe(5);
    expect(rows).toHaveLength(5);
  });

  it('filters with search across all columns (case insensitive)', async () => {
    const { rows, totalMatched } = await searchRowsStream(COLUMNS, ROWS, req({ search: 'alice' }));
    expect(totalMatched).toBe(2);
    expect(rows.map((r) => r[0])).toEqual([1, 5]);
  });

  it('filters with contains on a varchar column', async () => {
    const { rows, totalMatched } = await searchRowsStream(
      COLUMNS,
      ROWS,
      req({ filters: [{ columnIndex: 1, op: 'contains', value: 'li' }] }),
    );
    // Alice, charlie, ALICE のいずれも "li" を含む。
    expect(totalMatched).toBe(3);
    expect(rows.map((r) => r[1]).sort()).toEqual(['ALICE', 'Alice', 'charlie']);
  });

  it('filters numeric eq and treats null as non-matching', async () => {
    const { rows, totalMatched } = await searchRowsStream(
      COLUMNS,
      ROWS,
      req({ filters: [{ columnIndex: 0, op: 'eq', value: '2' }] }),
    );
    expect(totalMatched).toBe(1);
    expect(rows[0]).toEqual([2, 'Bob', null]);
  });

  it('filters numeric gt', async () => {
    const { rows, totalMatched } = await searchRowsStream(
      COLUMNS,
      ROWS,
      req({ filters: [{ columnIndex: 2, op: 'gt', value: '80' }] }),
    );
    expect(totalMatched).toBe(3);
    expect(rows.every((r) => Number(r[2]) > 80)).toBe(true);
  });

  it('filters varchar eq with exact match', async () => {
    const { totalMatched } = await searchRowsStream(
      COLUMNS,
      ROWS,
      req({ filters: [{ columnIndex: 1, op: 'eq', value: 'Bob' }] }),
    );
    expect(totalMatched).toBe(1);
  });

  it('filters neq: null cell does not match neq', async () => {
    const { totalMatched } = await searchRowsStream(
      COLUMNS,
      ROWS,
      req({ filters: [{ columnIndex: 1, op: 'neq', value: 'Bob' }] }),
    );
    // Alice, charlie, ALICE (null row excluded from neq match on null)
    expect(totalMatched).toBe(3);
  });

  it('filters isNull and notNull', async () => {
    const nullName = await searchRowsStream(
      COLUMNS,
      ROWS,
      req({ filters: [{ columnIndex: 1, op: 'isNull' }] }),
    );
    expect(nullName.totalMatched).toBe(1);
    expect(nullName.rows[0]![0]).toBe(4);

    const notNullScore = await searchRowsStream(
      COLUMNS,
      ROWS,
      req({ filters: [{ columnIndex: 2, op: 'notNull' }] }),
    );
    expect(notNullScore.totalMatched).toBe(4);
  });

  it('sorts numeric column; nulls first on asc and last on desc (ResultGrid semantics)', async () => {
    const asc = await searchRowsStream(
      COLUMNS,
      ROWS,
      req({ sort: { columnIndex: 2, dir: 'asc' } }),
    );
    expect(asc.rows[0]![2]).toBeNull();

    const desc = await searchRowsStream(
      COLUMNS,
      ROWS,
      req({ sort: { columnIndex: 2, dir: 'desc' } }),
    );
    expect(desc.rows[desc.rows.length - 1]![2]).toBeNull();
    expect(desc.rows[0]![2]).toBe(90);
  });

  it('sorts stably for equal keys', async () => {
    const { rows } = await searchRowsStream(
      COLUMNS,
      ROWS,
      req({ sort: { columnIndex: 2, dir: 'asc' } }),
    );
    // null 行の次に score=90 の行が元順 (id 1, 5) で並ぶ。
    const nineties = rows.filter((r) => r[2] === 90);
    expect(nineties.map((r) => r[0])).toEqual([1, 5]);
  });

  it('pages after filter and sort', async () => {
    const { rows, totalMatched } = await searchRowsStream(
      COLUMNS,
      ROWS,
      req({ sort: { columnIndex: 0, dir: 'asc' }, offset: 2, limit: 2 }),
    );
    expect(totalMatched).toBe(5);
    expect(rows).toEqual([
      [3, 'charlie', 70],
      [4, null, 85],
    ]);
  });

  it('pages without sort keeping only the requested window', async () => {
    const { rows, totalMatched, totalRows } = await searchRowsStream(
      COLUMNS,
      ROWS,
      req({ offset: 1, limit: 2 }),
    );
    expect(totalMatched).toBe(5);
    expect(totalRows).toBe(5);
    expect(rows).toEqual([
      [2, 'Bob', null],
      [3, 'charlie', 70],
    ]);
  });

  it('bounded selection with sort returns the same page as a full sort (1,000 rows)', async () => {
    const cols: QueryColumn[] = [
      { name: 'id', type: 'bigint' },
      { name: 'v', type: 'bigint' },
    ];
    // 値が重複するデータで、有界選択でも全体ソートと同じページ（安定順含む）になることを確認する。
    const rows = Array.from({ length: 1_000 }, (_, i) => [i, (i * 37) % 100]);
    const request = req({ sort: { columnIndex: 1, dir: 'asc' }, offset: 10, limit: 5 });

    const streamed = await searchRowsStream(cols, asStream(rows), request);

    // 期待値: 全行を安定ソートしてから同じ窓を切り出す。
    const expected = rows
      .map((row, i) => ({ row, i }))
      .sort((x, y) => {
        const cmp = Number(x.row[1]) - Number(y.row[1]);
        return cmp !== 0 ? cmp : x.i - y.i;
      })
      .map(({ row }) => row)
      .slice(10, 15);

    expect(streamed.totalMatched).toBe(1_000);
    expect(streamed.totalRows).toBe(1_000);
    expect(streamed.rows).toEqual(expected);
  });

  it('matches object cells via JSON.stringify in search', async () => {
    const cols: QueryColumn[] = [{ name: 'payload', type: 'json' }];
    const rows: unknown[][] = [[{ city: 'Tokyo' }], [['plain']]];
    const { totalMatched } = await searchRowsStream(
      cols,
      rows,
      req({ search: 'tokyo', limit: 10 }),
    );
    expect(totalMatched).toBe(1);
  });
});

describe('profileRowsStream', () => {
  it('computes nullCount and topValues', async () => {
    const { profiles, rowCount } = await profileRowsStream(COLUMNS, ROWS);
    expect(rowCount).toBe(5);
    expect(profiles[1]!.nullCount).toBe(1);
    expect(profiles[1]!.topValues[0]).toEqual({ value: 'Alice', count: 1 });
    const aliceEntry = profiles[1]!.topValues.find((v) => v.value === 'ALICE');
    expect(aliceEntry?.count).toBe(1);
  });

  it('works over an async row source', async () => {
    const { profiles, rowCount } = await profileRowsStream(COLUMNS, asStream(ROWS));
    expect(rowCount).toBe(5);
    expect(profiles[0]!.min).toBe('1');
    expect(profiles[0]!.max).toBe('5');
  });

  it('computes min/max for numeric and varchar columns', async () => {
    const { profiles } = await profileRowsStream(COLUMNS, ROWS);
    expect(profiles[0]!.min).toBe('1');
    expect(profiles[0]!.max).toBe('5');
    expect(profiles[1]!.min).toBe('Alice');
    expect(profiles[1]!.max).toBe('charlie');
    expect(profiles[2]!.min).toBe('70');
    expect(profiles[2]!.max).toBe('90');
  });

  it('tracks distinct count without overflow for small sets', async () => {
    const { profiles } = await profileRowsStream(COLUMNS, ROWS);
    expect(profiles[1]!.distinctCount).toBe(4);
    expect(profiles[1]!.distinctOverflow).toBe(false);
  });

  it('sets distinctOverflow after 10_000 distinct values', async () => {
    const cols: QueryColumn[] = [{ name: 'v', type: 'varchar' }];
    const rows = Array.from({ length: 10_001 }, (_, i) => [`value-${i}`]);
    const { profiles } = await profileRowsStream(cols, rows);
    expect(profiles[0]!.distinctOverflow).toBe(true);
    expect(profiles[0]!.distinctCount).toBe(10_000);
  });

  it('continues counting existing keys after distinct overflow', async () => {
    const cols: QueryColumn[] = [{ name: 'v', type: 'varchar' }];
    const rows: unknown[][] = [];
    for (let i = 0; i < 10_000; i++) rows.push([`v${i}`]);
    rows.push(['v9999'], ['overflow-new']);
    const { profiles } = await profileRowsStream(cols, rows);
    expect(profiles[0]!.distinctOverflow).toBe(true);
    expect(profiles[0]!.topValues.find((t) => t.value === 'v9999')).toEqual({
      value: 'v9999',
      count: 2,
    });
  });

  it('truncates long values to 100 characters for distinct keys and topValues', async () => {
    const cols: QueryColumn[] = [{ name: 'text', type: 'varchar' }];
    const long = 'x'.repeat(150);
    const { profiles } = await profileRowsStream(cols, [[long], [long]]);
    expect(profiles[0]!.topValues[0]!.value).toHaveLength(100);
    expect(profiles[0]!.distinctCount).toBe(1);
  });

  it('returns at most 10 top values ordered by count then appearance', async () => {
    const cols: QueryColumn[] = [{ name: 'k', type: 'varchar' }];
    const rows: unknown[][] = [];
    for (let i = 0; i < 3; i++) rows.push(['common']);
    rows.push(['b'], ['a'], ['c']);
    for (const letter of ['d', 'e', 'f', 'g', 'h', 'i', 'j', 'k']) rows.push([letter]);
    const { profiles } = await profileRowsStream(cols, rows);
    expect(profiles[0]!.topValues).toHaveLength(10);
    expect(profiles[0]!.topValues[0]).toEqual({ value: 'common', count: 3 });
  });
});
