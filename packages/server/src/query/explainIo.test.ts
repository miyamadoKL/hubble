import { describe, it, expect } from 'vitest';
import { parseExplainIoJson } from './explainIo';

// Fixtures mirror the real Trino 479 EXPLAIN (TYPE IO, FORMAT JSON) output.

const LINEITEM = JSON.stringify({
  inputTableColumnInfos: [
    {
      table: { catalog: 'tpch', schemaTable: { schema: 'sf1', table: 'lineitem' } },
      constraint: { none: false, columnConstraints: [] },
      estimate: {
        outputRowCount: 6001215.0,
        outputSizeInBytes: 7.83988912e8,
        cpuCost: 7.83988912e8,
        maxMemory: 0.0,
        networkCost: 0.0,
      },
    },
  ],
  estimate: {
    outputRowCount: 6001215.0,
    outputSizeInBytes: 7.83988912e8,
    cpuCost: 7.83988912e8,
    maxMemory: 0.0,
    networkCost: 0.0,
  },
});

// system.runtime.queries: statistics-less, so numbers are the string "NaN".
const NAN_TABLE = JSON.stringify({
  inputTableColumnInfos: [
    {
      table: { catalog: 'system', schemaTable: { schema: 'runtime', table: 'queries' } },
      constraint: { none: false, columnConstraints: [] },
      estimate: {
        outputRowCount: 'NaN',
        outputSizeInBytes: 'NaN',
        cpuCost: 'NaN',
        maxMemory: 0.0,
        networkCost: 0.0,
      },
    },
  ],
  estimate: { outputRowCount: 'NaN', outputSizeInBytes: 'NaN' },
});

describe('parseExplainIoJson', () => {
  it('parses a statistics-rich plan and sums scan figures', () => {
    const plan = parseExplainIoJson(LINEITEM)!;
    expect(plan.scanRows).toBe(6001215);
    expect(plan.scanBytes).toBe(783988912);
    expect(plan.outputRows).toBe(6001215);
    expect(plan.outputBytes).toBe(783988912);
    expect(plan.tables).toEqual([
      { catalog: 'tpch', schema: 'sf1', table: 'lineitem', rows: 6001215, bytes: 783988912 },
    ]);
  });

  it('treats "NaN" string estimates as null (unknown)', () => {
    const plan = parseExplainIoJson(NAN_TABLE)!;
    expect(plan.scanRows).toBeNull();
    expect(plan.scanBytes).toBeNull();
    expect(plan.outputRows).toBeNull();
    expect(plan.outputBytes).toBeNull();
    expect(plan.tables[0]).toEqual({
      catalog: 'system',
      schema: 'runtime',
      table: 'queries',
      rows: null,
      bytes: null,
    });
  });

  it('treats non-finite numbers (Infinity-encoded) as null', () => {
    const cell = JSON.stringify({
      inputTableColumnInfos: [
        {
          table: { catalog: 'c', schemaTable: { schema: 's', table: 't' } },
          estimate: { outputRowCount: 'Infinity', outputSizeInBytes: 'Infinity' },
        },
      ],
      estimate: {},
    });
    const plan = parseExplainIoJson(cell)!;
    expect(plan.scanRows).toBeNull();
    expect(plan.scanBytes).toBeNull();
  });

  it('sums known tables and ignores unknown ones in the totals', () => {
    const cell = JSON.stringify({
      inputTableColumnInfos: [
        {
          table: { catalog: 'c', schemaTable: { schema: 's', table: 'a' } },
          estimate: { outputRowCount: 100, outputSizeInBytes: 1000 },
        },
        {
          table: { catalog: 'c', schemaTable: { schema: 's', table: 'b' } },
          estimate: { outputRowCount: 'NaN', outputSizeInBytes: 'NaN' },
        },
        {
          table: { catalog: 'c', schemaTable: { schema: 's', table: 'd' } },
          estimate: { outputRowCount: 50, outputSizeInBytes: 500 },
        },
      ],
      estimate: { outputRowCount: 150, outputSizeInBytes: 1500 },
    });
    const plan = parseExplainIoJson(cell)!;
    expect(plan.scanRows).toBe(150);
    expect(plan.scanBytes).toBe(1500);
    expect(plan.tables.map((t) => t.table)).toEqual(['a', 'b', 'd']);
  });

  it('handles an empty inputTableColumnInfos (e.g. SHOW) as a zero-scan plan', () => {
    const cell = JSON.stringify({
      inputTableColumnInfos: [],
      estimate: { outputRowCount: 4.0, outputSizeInBytes: 220.0 },
    });
    const plan = parseExplainIoJson(cell)!;
    expect(plan.scanRows).toBeNull();
    expect(plan.scanBytes).toBeNull();
    expect(plan.tables).toEqual([]);
    expect(plan.outputRows).toBe(4);
  });

  it('tolerates a missing estimate field on a table', () => {
    const cell = JSON.stringify({
      inputTableColumnInfos: [
        { table: { catalog: 'c', schemaTable: { schema: 's', table: 't' } } },
      ],
      estimate: {},
    });
    const plan = parseExplainIoJson(cell)!;
    expect(plan.tables[0]).toEqual({
      catalog: 'c',
      schema: 's',
      table: 't',
      rows: null,
      bytes: null,
    });
    expect(plan.scanRows).toBeNull();
  });

  it('returns undefined for a non-JSON echoed statement (unsupported)', () => {
    expect(parseExplainIoJson('SET SESSION foo = 1')).toBeUndefined();
  });

  it('returns undefined for JSON that is not an IO plan', () => {
    expect(parseExplainIoJson('"just a string"')).toBeUndefined();
    expect(parseExplainIoJson('42')).toBeUndefined();
    expect(parseExplainIoJson('{"unrelated":true}')).toBeUndefined();
  });
});
