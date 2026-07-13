import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync, zstdCompressSync } from 'node:zlib';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import type { QueryColumn } from '@hubble/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { profileRowsStream } from '../query/exploration';
import { convertJsonlToParquet } from './parquetConverter';
import {
  buildDuckdbProfileS3Uris,
  buildDuckdbProfileSelectSql,
  createDuckdbPersistedProfileReader,
  expectedDuckdbPhysicalType,
  getDuckdbProfileEligibility,
  parseSafeDuckdbRowCount,
  physicalDuckdbColumnName,
  profileDuckdbParquetRows,
  type DuckdbProfileInput,
} from './duckdbProfile';

const fixtureDirectories: string[] = [];

afterEach(() => {
  for (const directory of fixtureDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixturePath(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'hubble-duckdb-profile-test-'));
  fixtureDirectories.push(directory);
  return join(directory, name);
}

function jsonlSource(
  format: 'jsonl.gz' | 'jsonl.zst',
  columns: readonly QueryColumn[],
  rows: readonly unknown[][],
): Readable {
  const payload = [
    JSON.stringify({ kind: 'columns', columns }),
    ...rows.map((row) => JSON.stringify({ kind: 'record', row })),
    '',
  ].join('\n');
  const compressed = format === 'jsonl.zst' ? zstdCompressSync(payload) : gzipSync(payload);
  return Readable.from(compressed);
}

function validInput(overrides: Partial<DuckdbProfileInput> = {}): DuckdbProfileInput {
  return {
    historyId: 'history-1',
    objectKey: 'results/history-1.parquet',
    parquetExpiresAt: '2099-01-01T00:00:00.000Z',
    rowCount: 1,
    columns: [{ name: 'value', type: 'varchar' }],
    bucket: 'bucket',
    prefix: 'results/',
    region: 'us-east-1',
    encodingVersion: '1',
    ...overrides,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function profileTempDirectories(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith('hubble-duckdb-profile-'));
}

function fakeDuckdbInstance(
  options: {
    interrupt?: () => void;
    run?: (sql: string) => Promise<void>;
    disconnectThrows?: boolean;
  } = {},
): {
  instance: DuckDBInstance;
  connection: DuckDBConnection;
  disconnectSync: ReturnType<typeof vi.fn>;
  closeSync: ReturnType<typeof vi.fn>;
} {
  const disconnectSync = vi.fn(() => {
    if (options.disconnectThrows) throw new Error('disconnect failed');
  });
  const closeSync = vi.fn();
  const run = vi.fn(async (sql: string) => {
    if (options.run !== undefined) await options.run(sql);
  });
  const stream = vi.fn(async (sql: string) => {
    const rows = sql.startsWith('DESCRIBE')
      ? [['c0000', 'VARCHAR']]
      : sql.startsWith('SELECT key')
        ? [
            ['hubble.encoding_version', '1'],
            ['hubble.row_count', '1'],
          ]
        : [['value']];
    return {
      yieldRowsJson: async function* () {
        yield rows;
      },
    };
  });
  const connection = {
    run,
    stream,
    disconnectSync,
    interrupt: vi.fn(options.interrupt),
  } as unknown as DuckDBConnection;
  const instance = {
    connect: vi.fn(async () => connection),
    closeSync,
  } as unknown as DuckDBInstance;
  return { instance, connection, disconnectSync, closeSync };
}

async function profileLocalParquet(
  outputPath: string,
  columns: readonly QueryColumn[],
): Promise<ReturnType<typeof profileDuckdbParquetRows>> {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  try {
    return await profileDuckdbParquetRows(connection, outputPath, columns);
  } finally {
    connection.disconnectSync();
    instance.closeSync();
  }
}

describe('DuckDB persisted profile eligibility and row mapping', () => {
  it('accepts only a fixed S3 artifact key and generated physical identifiers', () => {
    expect(getDuckdbProfileEligibility(validInput())).toEqual({ eligible: true });
    expect(buildDuckdbProfileS3Uris(validInput())).toEqual({
      objectUri: 's3://bucket/results/history-1.parquet',
      scope: 's3://bucket/results/',
    });
    expect(buildDuckdbProfileSelectSql(3)).toBe('SELECT c0000, c0001, c0002 FROM read_parquet(?)');
    expect(physicalDuckdbColumnName(12)).toBe('c0012');
    expect(expectedDuckdbPhysicalType('double precision')).toBe('DOUBLE');
    expect(getDuckdbProfileEligibility(validInput({ objectKey: 'results/other.parquet' }))).toEqual(
      { eligible: false, reason: 'object_key_mismatch' },
    );
    expect(getDuckdbProfileEligibility(validInput({ prefix: 'results' }))).toEqual({
      eligible: false,
      reason: 'invalid_s3_prefix',
    });
    expect(getDuckdbProfileEligibility(validInput({ prefix: 'results/#/' }))).toEqual({
      eligible: false,
      reason: 'invalid_s3_prefix',
    });
    expect(
      getDuckdbProfileEligibility(validInput({ objectKey: 'results/../history-1.parquet' })),
    ).toEqual({ eligible: false, reason: 'invalid_object_key' });
    expect(
      getDuckdbProfileEligibility(validInput({ objectKey: 'results/history-1.parquet?x=1' })),
    ).toEqual({ eligible: false, reason: 'invalid_object_key' });
  });

  it('rejects unsafe metadata row counts before DuckDB profile execution', () => {
    expect(parseSafeDuckdbRowCount('0')).toBe(0);
    expect(parseSafeDuckdbRowCount('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseSafeDuckdbRowCount('9007199254740992')).toBeUndefined();
    expect(parseSafeDuckdbRowCount('01')).toBeUndefined();
    expect(parseSafeDuckdbRowCount(undefined)).toBeUndefined();
  });

  it('matches profileRowsStream while streaming a local zstd Parquet artifact', async () => {
    const columns: QueryColumn[] = [
      { name: 'id', type: 'bigint' },
      { name: 'display', type: 'varchar' },
    ];
    const rows: unknown[][] = [
      ['-9223372036854775808', 'Z'],
      ['9223372036854775807', 'a'],
      [null, '😀'],
      ['1', 'x'.repeat(100)],
      ['2', 'x'.repeat(101)],
      ['3', '😀'.repeat(50)],
      ['4', '😀'.repeat(50) + 'a'],
    ];
    const outputPath = fixturePath('profile.parquet');
    await convertJsonlToParquet({
      source: jsonlSource('jsonl.zst', columns, rows),
      sourceFormat: 'jsonl.zst',
      columns,
      expectedRowCount: rows.length,
      outputPath,
    });

    const expected = await profileRowsStream(columns, rows);
    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();
    try {
      await expect(profileDuckdbParquetRows(connection, outputPath, columns)).resolves.toEqual({
        rowCount: expected.rowCount,
        complete: true,
        columns: expected.profiles,
      });
    } finally {
      connection.disconnectSync();
      instance.closeSync();
    }
  });

  it('preserves duplicate display names and v1 scalar type parity', async () => {
    const columns: QueryColumn[] = [
      { name: 'duplicate', type: 'boolean' },
      { name: 'duplicate', type: 'tinyint' },
      { name: 'duplicate', type: 'smallint' },
      { name: 'duplicate', type: 'integer' },
      { name: 'duplicate', type: 'bigint' },
      { name: 'duplicate', type: 'real' },
      { name: 'duplicate', type: 'double' },
      { name: 'duplicate', type: 'varchar' },
      { name: 'duplicate', type: 'text' },
    ];
    const rows: unknown[][] = [
      [true, -128, -32_768, -2_147_483_648, '-9223372036854775808', -1.5, -2.5, 'Z', null],
      [false, 127, 32_767, 2_147_483_647, '9223372036854775807', 1.5, 2.5, 'a', '非ASCII'],
      [null, null, null, null, null, null, null, 'Z', 'text'],
    ];
    const outputPath = fixturePath('scalar-types.parquet');
    await convertJsonlToParquet({
      source: jsonlSource('jsonl.zst', columns, rows),
      sourceFormat: 'jsonl.zst',
      columns,
      expectedRowCount: rows.length,
      outputPath,
    });

    const expected = await profileRowsStream(columns, rows);
    const actual = await profileLocalParquet(outputPath, columns);
    expect(actual).toEqual({
      rowCount: expected.rowCount,
      complete: true,
      columns: expected.profiles,
    });
    expect(actual.columns.map((column) => column.name)).toEqual(
      columns.map((column) => column.name),
    );
  });

  it('matches 10,000 distinct tracking, overflow, and post-overflow counts', async () => {
    const columns: QueryColumn[] = [{ name: 'value', type: 'varchar' }];
    const rows: unknown[][] = Array.from({ length: 10_000 }, (_, index) => ['v' + index]);
    rows.push(
      ['new-after-overflow'],
      ['new-after-overflow'],
      ['new-after-overflow'],
      ['v9999'],
      ['v9999'],
      ['v9999'],
      ['v9999'],
    );
    const outputPath = fixturePath('distinct-overflow.parquet');
    await convertJsonlToParquet({
      source: jsonlSource('jsonl.zst', columns, rows),
      sourceFormat: 'jsonl.zst',
      columns,
      expectedRowCount: rows.length,
      outputPath,
    });

    const expected = await profileRowsStream(columns, rows);
    const actual = await profileLocalParquet(outputPath, columns);
    expect(actual.columns).toEqual(expected.profiles);
    expect(actual.columns[0]).toMatchObject({
      distinctCount: 10_000,
      distinctOverflow: true,
      topValues: expect.arrayContaining([{ value: 'v9999', count: 5 }]),
    });
    expect(actual.columns[0]!.topValues).not.toContainEqual({
      value: 'new-after-overflow',
      count: 3,
    });
  });

  it('keeps top value ties in first occurrence order', async () => {
    const columns: QueryColumn[] = [{ name: 'value', type: 'varchar' }];
    const rows: unknown[][] = [['Z'], ['a'], ['Z'], ['a'], ['first-tie'], ['second-tie']];
    const outputPath = fixturePath('top-tie.parquet');
    await convertJsonlToParquet({
      source: jsonlSource('jsonl.gz', columns, rows),
      sourceFormat: 'jsonl.gz',
      columns,
      expectedRowCount: rows.length,
      outputPath,
    });

    const actual = await profileLocalParquet(outputPath, columns);
    expect(actual.columns[0]!.topValues.slice(2, 4)).toEqual([
      { value: 'first-tie', count: 1 },
      { value: 'second-tie', count: 1 },
    ]);
  });

  it('preserves empty and all-null profile parity through the row stream', async () => {
    const columns: QueryColumn[] = [
      { name: 'number', type: 'integer' },
      { name: 'text', type: 'text' },
    ];
    for (const [name, rows] of [
      ['empty', [] as unknown[][]],
      ['all-null', [[null, null]] as unknown[][]],
    ] as const) {
      const outputPath = fixturePath(name + '.parquet');
      await convertJsonlToParquet({
        source: jsonlSource('jsonl.gz', columns, rows),
        sourceFormat: 'jsonl.gz',
        columns,
        expectedRowCount: rows.length,
        outputPath,
      });
      const instance = await DuckDBInstance.create(':memory:');
      const connection = await instance.connect();
      try {
        const profile = await profileDuckdbParquetRows(connection, outputPath, columns);
        const expected = await profileRowsStream(columns, rows);
        expect(profile.columns).toEqual(expected.profiles);
        expect(profile.rowCount).toBe(expected.rowCount);
      } finally {
        connection.disconnectSync();
        instance.closeSync();
      }
    }
  });
});

describe('DuckDB profile resource admission and cleanup', () => {
  it('rejects a second request as overloaded while the first permit is held', async () => {
    const started = deferred<void>();
    const pendingInstance = deferred<DuckDBInstance>();
    const reader = createDuckdbPersistedProfileReader({
      enabled: true,
      concurrency: 1,
      waitTimeoutMs: 5,
      createInstance: async () => {
        started.resolve();
        return pendingInstance.promise;
      },
    });

    const first = reader(validInput());
    await started.promise;
    await expect(reader(validInput())).rejects.toMatchObject({ code: 'overloaded' });
    pendingInstance.reject(new Error('release permit'));
    await expect(first).rejects.toMatchObject({ code: 'duckdb_error' });
  });

  it('aborts a request waiting for a permit and releases the queue slot', async () => {
    const started = deferred<void>();
    const pendingInstance = deferred<DuckDBInstance>();
    let createCalls = 0;
    const reader = createDuckdbPersistedProfileReader({
      enabled: true,
      concurrency: 1,
      waitTimeoutMs: 1_000,
      createInstance: async () => {
        createCalls += 1;
        if (createCalls === 1) {
          started.resolve();
          return pendingInstance.promise;
        }
        throw new Error('second instance probe');
      },
    });

    const first = reader(validInput());
    await started.promise;
    const controller = new AbortController();
    const waiting = reader(validInput({ signal: controller.signal }));
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: 'aborted' });
    pendingInstance.reject(new Error('release permit'));
    await expect(first).rejects.toMatchObject({ code: 'duckdb_error' });
    await expect(reader(validInput())).rejects.toMatchObject({ code: 'duckdb_error' });
    expect(createCalls).toBe(2);
  });

  it('interrupts on timeout and keeps timeout as the first classification', async () => {
    const runStarted = deferred<void>();
    const runPending = deferred<void>();
    const controller = new AbortController();
    const fake = fakeDuckdbInstance({
      run: async () => {
        runStarted.resolve();
        return runPending.promise;
      },
      interrupt: () => runPending.reject(new Error('interrupted')),
    });
    const reader = createDuckdbPersistedProfileReader({
      enabled: true,
      timeoutMs: 10,
      createInstance: async () => fake.instance,
    });

    const result = reader(validInput({ signal: controller.signal }));
    const resultError = expect(result).rejects.toMatchObject({ code: 'timeout' });
    await runStarted.promise;
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort();

    await resultError;
    expect(fake.connection.interrupt).toHaveBeenCalledOnce();
  });

  it('cleans up the connection, instance, temp directory, and permit on success', async () => {
    const before = profileTempDirectories();
    const fake = fakeDuckdbInstance();
    const reader = createDuckdbPersistedProfileReader({
      enabled: true,
      createInstance: async () => fake.instance,
    });

    await expect(reader(validInput())).resolves.toMatchObject({
      rowCount: 1,
      complete: true,
    });

    expect(fake.disconnectSync).toHaveBeenCalledOnce();
    expect(fake.closeSync).toHaveBeenCalledOnce();
    expect(profileTempDirectories()).toEqual(before);
  });

  it('returns cleanup failure and releases the permit when disconnect fails', async () => {
    const before = profileTempDirectories();
    const first = fakeDuckdbInstance({ disconnectThrows: true });
    const second = fakeDuckdbInstance();
    let createCalls = 0;
    const reader = createDuckdbPersistedProfileReader({
      enabled: true,
      createInstance: async () => {
        createCalls += 1;
        return createCalls === 1 ? first.instance : second.instance;
      },
    });

    await expect(reader(validInput())).rejects.toMatchObject({ code: 'duckdb_error' });
    await expect(reader(validInput())).resolves.toMatchObject({ rowCount: 1 });
    expect(first.disconnectSync).toHaveBeenCalledOnce();
    expect(first.closeSync).toHaveBeenCalledOnce();
    expect(profileTempDirectories()).toEqual(before);
  });
});
