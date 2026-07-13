/**
 * E1b feasibility fixture。
 *
 * route は変更せず、Parquet の row stream を既存 searchRowsStream へ渡した場合に
 * JSONL 経路と同じ filter、search、sort、pagination の結果になることだけを検証する。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { zstdCompressSync } from 'node:zlib';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import type { QueryColumn, ResultSearchRequest } from '@hubble/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { searchRowsStream } from '../query/exploration';
import { openPersistedResult } from './jsonl';
import { convertJsonlToParquet } from './parquetConverter';

const fixtureDirectories: string[] = [];

afterEach(() => {
  for (const directory of fixtureDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function jsonlSource(columns: readonly QueryColumn[], rows: readonly unknown[][]): Readable {
  const payload = [
    JSON.stringify({ kind: 'columns', columns }),
    ...rows.map((row) => JSON.stringify({ kind: 'record', row })),
    '',
  ].join('\n');
  return Readable.from(zstdCompressSync(Buffer.from(payload)));
}

async function* parquetRows(
  connection: DuckDBConnection,
  path: string,
  columnCount: number,
): AsyncGenerator<unknown[]> {
  const columns = Array.from(
    { length: columnCount },
    (_, index) => 'c' + String(index).padStart(4, '0'),
  );
  const result = await connection.stream(`SELECT ${columns.join(', ')} FROM read_parquet(?)`, [
    path,
  ]);
  for await (const chunk of result.yieldRowsJson()) {
    for (const row of chunk) yield row as unknown[];
  }
}

describe('E1b DuckDB persisted search feasibility', () => {
  it('matches JSONL searchRowsStream semantics without changing the route', async () => {
    const columns: QueryColumn[] = [
      { name: 'id', type: 'integer' },
      { name: 'label', type: 'varchar' },
      { name: 'active', type: 'boolean' },
    ];
    const rows: unknown[][] = [
      [0, 'Tokyo', true],
      [1, 'osaka', false],
      [2, null, true],
      [3, 'Kyoto', false],
      [4, 'tokyo', true],
      [5, 'Nagoya', null],
    ];
    const directory = mkdtempSync(join(tmpdir(), 'hubble-duckdb-search-feasibility-'));
    fixtureDirectories.push(directory);
    const parquetPath = join(directory, 'search.parquet');
    await convertJsonlToParquet({
      source: jsonlSource(columns, rows),
      sourceFormat: 'jsonl.zst',
      columns,
      expectedRowCount: rows.length,
      outputPath: parquetPath,
    });

    const requests: ResultSearchRequest[] = [
      { search: 'TOKYO', offset: 0, limit: 10 },
      {
        filters: [{ columnIndex: 0, op: 'gte', value: '2' }],
        sort: { columnIndex: 0, dir: 'desc' },
        offset: 1,
        limit: 2,
      },
      { filters: [{ columnIndex: 1, op: 'isNull' }], offset: 0, limit: 10 },
      {
        filters: [{ columnIndex: 2, op: 'notNull' }],
        sort: { columnIndex: 1, dir: 'asc' },
        offset: 0,
        limit: 10,
      },
    ];

    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();
    try {
      for (const request of requests) {
        const expected = await searchRowsStream(columns, rows, request);
        const actual = await searchRowsStream(
          columns,
          parquetRows(connection, parquetPath, columns.length),
          request,
        );
        expect(actual).toEqual(expected);
      }
    } finally {
      connection.disconnectSync();
      instance.closeSync();
    }
  });

  it('records raw-row type and precision differences before deferring the route', async () => {
    const columns: QueryColumn[] = [
      { name: 'safe_bigint', type: 'bigint' },
      { name: 'unsafe_bigint', type: 'bigint' },
      { name: 'connector_string_bigint', type: 'bigint' },
      { name: 'real_value', type: 'real' },
      { name: 'double_value', type: 'double' },
      { name: 'integer_value', type: 'integer' },
      { name: 'boolean_value', type: 'boolean' },
      { name: 'varchar_value', type: 'varchar' },
      { name: 'nullable_value', type: 'varchar' },
    ];
    const rows: unknown[][] = [
      [42, '9007199254740993', '42', 0.1, 0.1, 7, true, '東京', null],
      [-1, '-9223372036854775808', '-1', -0.1, 0.10000000000000002, -3, false, 'plain', 'value'],
    ];
    const directory = mkdtempSync(join(tmpdir(), 'hubble-duckdb-search-types-'));
    fixtureDirectories.push(directory);
    const parquetPath = join(directory, 'search-types.parquet');
    await convertJsonlToParquet({
      source: jsonlSource(columns, rows),
      sourceFormat: 'jsonl.zst',
      columns,
      expectedRowCount: rows.length,
      outputPath: parquetPath,
    });

    const request: ResultSearchRequest = { offset: 0, limit: 10 };
    const jsonlCursor = await openPersistedResult(jsonlSource(columns, rows), {
      format: 'jsonl.zst',
      key: 'feasibility.jsonl.zst',
    });
    const expected = await searchRowsStream(columns, jsonlCursor.rows, request);
    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();
    try {
      const actual = await searchRowsStream(
        columns,
        parquetRows(connection, parquetPath, columns.length),
        request,
      );
      const expectedJson = JSON.stringify({
        offset: request.offset,
        rows: expected.rows,
        totalMatched: expected.totalMatched,
        totalRows: expected.totalRows,
        complete: true,
      });
      const actualJson = JSON.stringify({
        offset: request.offset,
        rows: actual.rows,
        totalMatched: actual.totalMatched,
        totalRows: actual.totalRows,
        complete: true,
      });
      // raw wire representation が一致しない間は E1b route を実装可能とは扱わない。
      expect(actualJson).not.toBe(expectedJson);
      expect(actual.rows).not.toEqual(expected.rows);
    } finally {
      connection.disconnectSync();
      instance.closeSync();
    }
  });
});
