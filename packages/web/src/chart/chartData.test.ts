import { describe, it, expect } from 'vitest';
import type { QueryColumn } from '@hubble/contracts';
import {
  classifyType,
  describeColumns,
  xCandidates,
  yCandidates,
  groupCandidates,
  defaultConfig,
  reconcileConfig,
  applySortLimit,
  toNumber,
  toTime,
  type ChartConfig,
} from './chartData';

const columns: QueryColumn[] = [
  { name: 'orderpriority', type: 'varchar(15)' },
  { name: 'c', type: 'bigint' },
  { name: 's', type: 'double' },
  { name: 'orderdate', type: 'date' },
];

const rows = [
  ['5-LOW', 3, 100.5, '1995-01-02'],
  ['1-URGENT', 1, 50.25, '1995-01-01'],
  ['3-MEDIUM', 2, 75.0, '1995-01-03'],
];

describe('classifyType', () => {
  it('maps numeric Trino types to number', () => {
    for (const t of ['bigint', 'integer', 'smallint', 'tinyint', 'double', 'real', 'decimal(10,2)', 'numeric']) {
      expect(classifyType(t)).toBe('number');
    }
  });
  it('maps temporal types to temporal', () => {
    for (const t of ['date', 'timestamp', 'timestamp(3)', 'time', 'time with time zone']) {
      expect(classifyType(t)).toBe('temporal');
    }
  });
  it('maps the rest to string', () => {
    for (const t of ['varchar(15)', 'varchar', 'char(3)', 'boolean', 'json', 'array(varchar)']) {
      expect(classifyType(t)).toBe('string');
    }
  });
});

describe('column candidates', () => {
  const cols = describeColumns(columns);
  it('X candidates for bars include string + temporal + number', () => {
    expect(xCandidates(cols, 'bars').map((c) => c.name)).toEqual([
      'orderpriority',
      'c',
      's',
      'orderdate',
    ]);
  });
  it('X candidates for timeline are temporal only', () => {
    expect(xCandidates(cols, 'timeline').map((c) => c.name)).toEqual(['orderdate']);
  });
  it('X candidates for scatter are numeric only', () => {
    expect(xCandidates(cols, 'scatter').map((c) => c.name)).toEqual(['c', 's']);
  });
  it('Y candidates are numeric only', () => {
    expect(yCandidates(cols).map((c) => c.name)).toEqual(['c', 's']);
  });
  it('group candidates exclude numeric columns', () => {
    expect(groupCandidates(cols).map((c) => c.name)).toEqual(['orderpriority', 'orderdate']);
  });
});

describe('defaultConfig', () => {
  it('picks a categorical X and the first numeric measure', () => {
    const cfg = defaultConfig(describeColumns(columns));
    expect(cfg).not.toBeNull();
    expect(cfg!.type).toBe('bars');
    expect(cfg!.xIndex).toBe(0); // orderpriority
    expect(cfg!.yIndices).toEqual([1]); // c
  });
  it('returns null when there is no numeric column', () => {
    expect(defaultConfig(describeColumns([{ name: 'a', type: 'varchar' }]))).toBeNull();
  });
});

describe('reconcileConfig', () => {
  const cols = describeColumns(columns);
  it('drops invalid Y references and back-fills', () => {
    const prev: ChartConfig = {
      type: 'bars',
      xIndex: 0,
      yIndices: [0, 1], // 0 is non-numeric → dropped
      sort: 'desc',
      limit: 10,
    };
    const next = reconcileConfig(prev, cols)!;
    expect(next.yIndices).toEqual([1]);
    expect(next.sort).toBe('desc');
    expect(next.limit).toBe(10);
  });
  it('resets X when invalid for the new chart type', () => {
    const prev: ChartConfig = {
      type: 'timeline',
      xIndex: 0, // orderpriority is not temporal
      yIndices: [2],
      sort: 'none',
      limit: 'all',
    };
    const next = reconcileConfig(prev, cols)!;
    expect(cols[next.xIndex!]!.valueClass).toBe('temporal');
  });
  it('falls back to default when prev is null', () => {
    expect(reconcileConfig(null, cols)).toEqual(defaultConfig(cols));
  });
});

describe('toNumber / toTime', () => {
  it('coerces strings and rejects non-finite', () => {
    expect(toNumber('42')).toBe(42);
    expect(toNumber(3.14)).toBe(3.14);
    expect(toNumber('nope')).toBeNull();
    expect(toNumber(null)).toBeNull();
  });
  it('parses dates and space-separated timestamps', () => {
    expect(toTime('1995-01-01')).toBe(Date.parse('1995-01-01'));
    expect(toTime('1995-01-01 12:30:00')).toBe(Date.parse('1995-01-01T12:30:00'));
    expect(toTime('garbage')).toBeNull();
  });
});

describe('applySortLimit', () => {
  it('keeps result order when sort=none', () => {
    const cfg: ChartConfig = { type: 'bars', xIndex: 0, yIndices: [1], sort: 'none', limit: 'all' };
    expect(applySortLimit(rows, cfg)).toEqual(rows);
  });
  it('sorts ascending by the first measure', () => {
    const cfg: ChartConfig = { type: 'bars', xIndex: 0, yIndices: [1], sort: 'asc', limit: 'all' };
    expect(applySortLimit(rows, cfg).map((r) => r[1])).toEqual([1, 2, 3]);
  });
  it('sorts descending by the first measure', () => {
    const cfg: ChartConfig = { type: 'bars', xIndex: 0, yIndices: [1], sort: 'desc', limit: 'all' };
    expect(applySortLimit(rows, cfg).map((r) => r[1])).toEqual([3, 2, 1]);
  });
  it('caps the row count at the limit', () => {
    const many = Array.from({ length: 30 }, (_, i) => ['x', i, 0, '1995-01-01']);
    const cfg: ChartConfig = { type: 'bars', xIndex: 0, yIndices: [1], sort: 'none', limit: 5 };
    expect(applySortLimit(many, cfg)).toHaveLength(5);
  });
});
