import { describe, expect, it } from 'vitest';
import type { QueryColumn } from '@hubble/contracts';
import type { ResultRow } from '../../execution';
import {
  buildClientViewIndices,
  calculateColumnWidths,
  columnWidthChangeKey,
  materializeClientRow,
} from './ResultGrid';

const columns: QueryColumn[] = [
  { name: 'label', type: 'varchar' },
  { name: 'value', type: 'bigint' },
];

describe('ResultGrid row projection', () => {
  const rows: ResultRow[] = [
    ['b', 2],
    ['alpha', 3],
    ['Alpha', 1],
  ];

  it('does not allocate an index view without sort or filter', () => {
    expect(buildClientViewIndices(rows, columns, '', null)).toBeNull();
  });

  it('preserves source indices through filter and stable sort', () => {
    expect(buildClientViewIndices(rows, columns, 'ALPHA', null)).toEqual([1, 2]);
    expect(buildClientViewIndices(rows, columns, '', { colIndex: 1, dir: 'asc' })).toEqual([
      2, 0, 1,
    ]);
  });

  it('materializes only the requested virtual row', () => {
    let reads = 0;
    const tracked = new Proxy(rows, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) reads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(materializeClientRow(tracked, null, 2)).toEqual({ row: ['Alpha', 1], sourceIndex: 2 });
    expect(reads).toBe(1);
  });
});

describe('ResultGrid column widths', () => {
  it('freezes the sample key and ignores rows after the first 1000', () => {
    const rows = Array.from({ length: 1000 }, (_, index) => [`row-${index}`, index]);
    const visible = columns.map((col, index) => ({ col, index }));
    const before = calculateColumnWidths(rows, visible);
    const key = columnWidthChangeKey(rows, 10);

    rows.push(['x'.repeat(200), 1000]);

    expect(columnWidthChangeKey(rows, 11)).toBe(key);
    expect(calculateColumnWidths(rows, visible)).toEqual(before);
  });

  it('tracks replay changes while the sample is incomplete', () => {
    const rows: ResultRow[] = [['short', 1]];
    expect(columnWidthChangeKey(rows, 1)).not.toBe(columnWidthChangeKey(rows, 2));
  });
});
