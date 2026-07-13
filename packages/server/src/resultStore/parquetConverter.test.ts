import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync, zstdCompressSync } from 'node:zlib';
import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import type { QueryColumn } from '@hubble/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  convertJsonlToParquet,
  ParquetConverterError,
  type ParquetConverterInput,
} from './parquetConverter';

const fixtureDirectories: string[] = [];

afterEach(() => {
  for (const directory of fixtureDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createFixturePath(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'hubble-parquet-converter-test-'));
  fixtureDirectories.push(directory);
  return join(directory, name);
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function jsonlSource(
  format: 'jsonl.gz' | 'jsonl.zst',
  columns: readonly QueryColumn[],
  rows: readonly unknown[][],
): Readable {
  const payload = `${[
    JSON.stringify({ kind: 'columns', columns }),
    ...rows.map((row) => JSON.stringify({ kind: 'record', row })),
  ].join('\n')}\n`;
  return compressedSource(format, payload);
}

function compressedSource(format: 'jsonl.gz' | 'jsonl.zst', payload: string): Readable {
  const compressed =
    format === 'jsonl.zst'
      ? zstdCompressSync(Buffer.from(payload))
      : gzipSync(Buffer.from(payload));
  return Readable.from(compressed);
}

function converterInput(
  outputPath: string,
  columns: readonly QueryColumn[],
  rows: readonly unknown[][],
  options: Partial<
    Pick<ParquetConverterInput, 'sourceFormat' | 'expectedRowCount' | 'signal'>
  > = {},
): ParquetConverterInput {
  const sourceFormat = options.sourceFormat ?? 'jsonl.gz';
  return {
    source: jsonlSource(sourceFormat, columns, rows),
    sourceFormat,
    columns,
    expectedRowCount: options.expectedRowCount ?? rows.length,
    outputPath,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

async function readParquet(path: string): Promise<{
  rows: unknown[][];
  columns: Array<{ column_name: string; column_type: string }>;
  metadata: Array<{ key: string; value: string }>;
  compressions: string[];
  rowGroupCount: number;
}> {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  try {
    const rowsReader = await connection.runAndReadAll(
      `SELECT * FROM read_parquet(${sqlString(path)})`,
    );
    const describeReader = await connection.runAndReadAll(
      `DESCRIBE SELECT * FROM read_parquet(${sqlString(path)})`,
    );
    const metadataReader = await connection.runAndReadAll(
      `SELECT key, value FROM parquet_kv_metadata(${sqlString(path)}) ORDER BY key`,
    );
    const compressionReader = await connection.runAndReadAll(
      `SELECT DISTINCT compression FROM parquet_metadata(${sqlString(path)}) ORDER BY compression`,
    );
    const rowGroupReader = await connection.runAndReadAll(
      `SELECT count(DISTINCT row_group_id) FROM parquet_metadata(${sqlString(path)})`,
    );
    return {
      rows: await rowsReader.getRowsJson(),
      columns: (await describeReader.getRowsJson()).map((row) => ({
        column_name: String(row[0]),
        column_type: String(row[1]),
      })),
      metadata: (await metadataReader.getRowsJson()).map((row) => ({
        key: String(row[0]),
        value: String(row[1]),
      })),
      compressions: (await compressionReader.getRowsJson()).map((row) => String(row[0])),
      rowGroupCount: Number((await rowGroupReader.getRowsJson())[0]?.[0]),
    };
  } finally {
    connection.disconnectSync();
    instance.closeSync();
  }
}

async function expectConverterError(
  input: ParquetConverterInput,
  code: ParquetConverterError['code'],
): Promise<ParquetConverterError> {
  const error = await convertJsonlToParquet(input).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ParquetConverterError);
  expect(error).toMatchObject({ code });
  return error as ParquetConverterError;
}

function delayedJsonlSource(
  columns: readonly QueryColumn[],
  rowCount: number,
): { source: Readable; isDestroyed: () => boolean } {
  const payload = Buffer.from(
    `${[
      JSON.stringify({ kind: 'columns', columns }),
      ...Array.from({ length: rowCount }, (_, index) =>
        JSON.stringify({ kind: 'record', row: [index] }),
      ),
    ].join('\n')}\n`,
  );
  const compressed = gzipSync(payload);
  const chunkSize = Math.ceil(compressed.length / 32);
  const chunks = Array.from({ length: 32 }, (_, index) =>
    compressed.subarray(index * chunkSize, (index + 1) * chunkSize),
  );
  let destroyed = false;
  const source = new Readable({
    read() {
      const chunk = chunks.shift();
      if (chunk === undefined) {
        this.push(null);
        return;
      }
      setTimeout(() => this.push(chunk), 5);
    },
    destroy(error, callback) {
      destroyed = true;
      callback(error);
    },
  });
  return { source, isDestroyed: () => destroyed };
}

async function convertWithDelayedCopyFailure(
  input: ParquetConverterInput,
  onCopyStart: () => void,
  delayMs: number,
): Promise<unknown> {
  const originalRun = DuckDBConnection.prototype.run;
  const runSpy = vi.spyOn(DuckDBConnection.prototype, 'run').mockImplementation(function (
    this: DuckDBConnection,
    sql,
    values,
    types,
  ) {
    if (sql.trimStart().startsWith('COPY ')) {
      onCopyStart();
      return new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('delayed COPY failure')), delayMs);
      });
    }
    return originalRun.call(this, sql, values, types);
  });
  try {
    return await convertJsonlToParquet(input).catch((error: unknown) => error);
  } finally {
    runSpy.mockRestore();
  }
}

describe('convertJsonlToParquet', () => {
  it('converts scalar values with nulls and preserves ordinal physical names', async () => {
    const columns: QueryColumn[] = [
      { name: 'duplicate', type: 'boolean' },
      { name: 'duplicate', type: 'tinyint' },
      { name: 'duplicate', type: 'smallint' },
      { name: 'integer value', type: 'integer' },
      { name: 'large value', type: 'bigint' },
      { name: 'real value', type: 'real' },
      { name: 'double value', type: 'double precision' },
      { name: 'text value', type: 'varchar(8)' },
      { name: 'nullable', type: 'text' },
    ];
    const rows = [
      [true, -128, -32_768, -2_147_483_648, '-9223372036854775808', 1.5, 2.5, 'alpha', null],
      [false, 127, 32_767, 2_147_483_647, '9223372036854775807', -1.25, 0, 'beta', 'value'],
    ];
    const outputPath = createFixturePath('result.parquet');

    await expect(convertJsonlToParquet(converterInput(outputPath, columns, rows))).resolves.toEqual(
      {
        outputPath,
        rowCount: 2,
      },
    );
    const result = await readParquet(outputPath);

    expect(result.columns.map((column) => column.column_name)).toEqual([
      'c0000',
      'c0001',
      'c0002',
      'c0003',
      'c0004',
      'c0005',
      'c0006',
      'c0007',
      'c0008',
    ]);
    expect(result.columns.map((column) => column.column_type)).toEqual([
      'BOOLEAN',
      'TINYINT',
      'SMALLINT',
      'INTEGER',
      'BIGINT',
      'FLOAT',
      'DOUBLE',
      'VARCHAR',
      'VARCHAR',
    ]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]?.slice(0, 4)).toEqual([true, -128, -32_768, -2_147_483_648]);
    expect(String(result.rows[0]?.[4])).toBe('-9223372036854775808');
    expect(result.rows[0]?.slice(5)).toEqual([1.5, 2.5, 'alpha', null]);
    expect(String(result.rows[1]?.[4])).toBe('9223372036854775807');
    expect(result.metadata).toEqual([
      { key: 'hubble.encoding_version', value: '1' },
      { key: 'hubble.row_count', value: '2' },
    ]);
    expect(result.compressions).toEqual(['ZSTD']);
    expect(result.rowGroupCount).toBe(1);
  });

  it('supports a zstd source, empty results, and all-null rows', async () => {
    const columns: QueryColumn[] = [
      { name: 'empty or null', type: 'integer' },
      { name: 'empty or null', type: 'text' },
    ];
    const emptyPath = createFixturePath('empty.parquet');
    await expect(
      convertJsonlToParquet(converterInput(emptyPath, columns, [], { sourceFormat: 'jsonl.zst' })),
    ).resolves.toMatchObject({ rowCount: 0 });
    await expect(readParquet(emptyPath)).resolves.toMatchObject({
      rows: [],
      metadata: [
        { key: 'hubble.encoding_version', value: '1' },
        { key: 'hubble.row_count', value: '0' },
      ],
    });

    const nullPath = createFixturePath('all-null.parquet');
    await expect(
      convertJsonlToParquet(
        converterInput(nullPath, columns, [[null, null]], { sourceFormat: 'jsonl.zst' }),
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
    await expect(readParquet(nullPath)).resolves.toMatchObject({ rows: [[null, null]] });
  });

  it('rejects unsupported types as permanent errors without creating output', async () => {
    const outputPath = createFixturePath('unsupported.parquet');
    const source = jsonlSource('jsonl.gz', [{ name: 'amount', type: 'decimal(10,2)' }], [['1.00']]);
    const error = await expectConverterError(
      {
        source,
        sourceFormat: 'jsonl.gz',
        columns: [{ name: 'amount', type: 'decimal(10,2)' }],
        expectedRowCount: 1,
        outputPath,
      },
      'unsupported_type',
    );

    expect(error.permanent).toBe(true);
    expect(source.destroyed).toBe(true);
    expect(existsSync(outputPath)).toBe(false);
  });

  it('classifies malformed JSONL and does not delete an existing output', async () => {
    const malformedPath = createFixturePath('malformed.parquet');
    await expectConverterError(
      {
        source: compressedSource('jsonl.gz', '{"kind":"invalid"}\n'),
        sourceFormat: 'jsonl.gz',
        columns: [{ name: 'id', type: 'integer' }],
        expectedRowCount: 0,
        outputPath: malformedPath,
      },
      'malformed_row',
    );

    const existingPath = createFixturePath('existing.parquet');
    writeFileSync(existingPath, 'keep this file');
    await expectConverterError(
      converterInput(existingPath, [{ name: 'id', type: 'integer' }], []),
      'invalid_value',
    );
    expect(existsSync(existingPath)).toBe(true);
  });

  it('rejects unsafe bigint values as permanent invalid-value errors', async () => {
    const outputPath = createFixturePath('unsafe-bigint.parquet');
    const error = await expectConverterError(
      converterInput(outputPath, [{ name: 'id', type: 'bigint' }], [[Number.MAX_SAFE_INTEGER + 1]]),
      'invalid_value',
    );

    expect(error.permanent).toBe(true);
    expect(existsSync(outputPath)).toBe(false);
  });

  it('prioritizes a pre-aborted signal over schema validation', async () => {
    const outputPath = createFixturePath('pre-aborted.parquet');
    const source = jsonlSource('jsonl.gz', [{ name: 'value', type: 'not-a-type' }], []);
    const controller = new AbortController();
    controller.abort();

    const error = await expectConverterError(
      {
        source,
        sourceFormat: 'jsonl.gz',
        columns: [{ name: 'value', type: 'not-a-type' }],
        expectedRowCount: 0,
        outputPath,
        signal: controller.signal,
      },
      'aborted',
    );

    expect(error.permanent).toBe(false);
    expect(source.destroyed).toBe(true);
  });

  it('rejects malformed row widths and row-count mismatches', async () => {
    const widthPath = createFixturePath('width.parquet');
    await expectConverterError(
      converterInput(widthPath, [{ name: 'id', type: 'integer' }], [[1, 2]]),
      'malformed_row',
    );
    expect(existsSync(widthPath)).toBe(false);

    const countPath = createFixturePath('count.parquet');
    await expectConverterError(
      converterInput(countPath, [{ name: 'id', type: 'integer' }], [[1]], {
        expectedRowCount: 2,
      }),
      'row_count_mismatch',
    );
    expect(existsSync(countPath)).toBe(false);
  });

  it('returns aborted for an external signal and closes the source', async () => {
    const outputPath = createFixturePath('aborted.parquet');
    const columns = [{ name: 'id', type: 'integer' }];
    const { source, isDestroyed } = delayedJsonlSource(columns, 20_000);
    const controller = new AbortController();
    const conversion = convertJsonlToParquet({
      source,
      sourceFormat: 'jsonl.gz',
      columns,
      expectedRowCount: 20_000,
      outputPath,
      signal: controller.signal,
      resourceLimits: { timeoutMs: 100 },
    });
    setTimeout(() => controller.abort(), 20);

    const error = await conversion.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'aborted', permanent: false });
    expect(isDestroyed()).toBe(true);
    expect(existsSync(outputPath)).toBe(false);
  });

  it('returns timed_out when the converter timeout fires', async () => {
    const outputPath = createFixturePath('timed-out.parquet');
    const columns = [{ name: 'id', type: 'integer' }];
    const { source, isDestroyed } = delayedJsonlSource(columns, 20_000);

    const error = await expectConverterError(
      {
        source,
        sourceFormat: 'jsonl.gz',
        columns,
        expectedRowCount: 20_000,
        outputPath,
        resourceLimits: { timeoutMs: 50 },
      },
      'timed_out',
    );

    expect(error.permanent).toBe(false);
    expect(isDestroyed()).toBe(true);
    expect(existsSync(outputPath)).toBe(false);
  });

  it('reports close failures after a successful Parquet write', async () => {
    const outputPath = createFixturePath('cleanup-error.parquet');
    const disconnectSpy = vi
      .spyOn(DuckDBConnection.prototype, 'disconnectSync')
      .mockImplementation(() => {
        throw new Error('disconnect failed');
      });
    const closeSpy = vi.spyOn(DuckDBInstance.prototype, 'closeSync').mockImplementation(() => {
      throw new Error('instance close failed');
    });

    let error: ParquetConverterError;
    try {
      error = await expectConverterError(
        converterInput(outputPath, [{ name: 'id', type: 'integer' }], [[1]]),
        'duckdb_error',
      );
      expect(error.permanent).toBe(false);
      expect(disconnectSpy).toHaveBeenCalled();
      expect(closeSpy).toHaveBeenCalled();
    } finally {
      disconnectSpy.mockRestore();
      closeSpy.mockRestore();
    }
    expect(error!.permanent).toBe(false);
    expect(existsSync(outputPath)).toBe(false);
    await expect(
      convertJsonlToParquet(converterInput(outputPath, [{ name: 'id', type: 'integer' }], [[1]])),
    ).resolves.toMatchObject({ rowCount: 1 });
    expect(existsSync(outputPath)).toBe(true);
  });

  it('keeps external abort as the first cause when timeout fires during COPY rejection', async () => {
    const outputPath = createFixturePath('external-first.parquet');
    const controller = new AbortController();

    const error = await convertWithDelayedCopyFailure(
      {
        source: jsonlSource('jsonl.gz', [{ name: 'id', type: 'integer' }], [[1]]),
        sourceFormat: 'jsonl.gz',
        columns: [{ name: 'id', type: 'integer' }],
        expectedRowCount: 1,
        outputPath,
        signal: controller.signal,
        resourceLimits: { timeoutMs: 500 },
      },
      () => controller.abort(),
      650,
    );

    expect(error).toMatchObject({ code: 'aborted', permanent: false });
    expect(existsSync(outputPath)).toBe(false);
  });

  it('returns timeout when timeout fires before a delayed COPY rejection', async () => {
    const outputPath = createFixturePath('timeout-first.parquet');

    const error = await convertWithDelayedCopyFailure(
      {
        source: jsonlSource('jsonl.gz', [{ name: 'id', type: 'integer' }], [[1]]),
        sourceFormat: 'jsonl.gz',
        columns: [{ name: 'id', type: 'integer' }],
        expectedRowCount: 1,
        outputPath,
        resourceLimits: { timeoutMs: 500 },
      },
      () => undefined,
      650,
    );

    expect(error).toMatchObject({ code: 'timed_out', permanent: false });
    expect(existsSync(outputPath)).toBe(false);
  });

  it('writes ZSTD Parquet with multiple row groups above the configured size', async () => {
    const outputPath = createFixturePath('multiple-row-groups.parquet');
    const rows = Array.from({ length: 20_001 }, (_, index) => [
      index,
      `${index}`.padEnd(1_024, 'x'),
    ]);

    await expect(
      convertJsonlToParquet(
        converterInput(
          outputPath,
          [
            { name: 'id', type: 'integer' },
            { name: 'payload', type: 'text' },
          ],
          rows,
        ),
      ),
    ).resolves.toMatchObject({ rowCount: 20_001 });
    const result = await readParquet(outputPath);

    expect(result.compressions).toEqual(['ZSTD']);
    expect(result.rowGroupCount).toBeGreaterThan(1);
    expect(result.metadata).toContainEqual({ key: 'hubble.row_count', value: '20001' });
  });
});
