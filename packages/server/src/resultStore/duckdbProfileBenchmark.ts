/**
 * Parquet profile の rollout 判断用 benchmark。
 *
 * local artifact の decode と profile 処理だけを測る informative な計測であり、
 * S3 の network latency、fresh DuckDB instance の起動時間、metadata validation は
 * production の end-to-end latency として扱わない。
 */
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Readable } from 'node:stream';
import { zstdCompressSync } from 'node:zlib';
import type { QueryColumn } from '@hubble/contracts';
import { convertJsonlToParquet } from './parquetConverter';
import { profileDuckdbParquetRows } from './duckdbProfile';
import { openPersistedResult } from './jsonl';
import { profileRowsStream } from '../query/exploration';

type DatasetName = 'small' | 'medium' | 'large' | 'high-cardinality';
type BenchmarkMode = 'jsonl-zstd' | 'jsonl-fallback' | 'duckdb-parquet';
type Temperature = 'cold' | 'warm';

interface BenchmarkRun {
  rowCount: number;
  queueWaitMs: number;
  duckdbDurationMs: number;
  jsonlFallbackDurationMs: number;
}

interface BenchmarkCase {
  dataset: DatasetName;
  mode: BenchmarkMode;
  temperature: Temperature;
  rowCount: number;
  rowCountBucket: string;
  fallbackReason: string;
  repeats: number;
  p50Ms: number;
  p95Ms: number;
  rowsPerSecondP50: number;
  queueWaitMs: number;
  duckdbDurationMs: number;
  jsonlFallbackDurationMs: number;
  peakRssBytes: number;
  tempBytes: number;
}

const ROW_COUNT_OVERRIDE = Number(process.env.DUCKDB_PROFILE_BENCH_ROWS ?? '0');
const WARMUP = Number(process.env.DUCKDB_PROFILE_BENCH_WARMUP ?? 1);
const REPEATS = Number(process.env.DUCKDB_PROFILE_BENCH_REPEATS ?? 5);
const DATASET_FILTER = process.env.DUCKDB_PROFILE_BENCH_DATASET?.trim() as DatasetName | undefined;

const columns: QueryColumn[] = [
  { name: 'id', type: 'bigint' },
  { name: 'label', type: 'varchar' },
  { name: 'active', type: 'boolean' },
];

const datasetRows: Record<DatasetName, number> = {
  small: ROW_COUNT_OVERRIDE > 0 ? ROW_COUNT_OVERRIDE : 1_000,
  medium: 10_000,
  large: 50_000,
  'high-cardinality': 10_000,
};

function rowCountBucket(rowCount: number): string {
  if (rowCount <= 0) return '0';
  if (rowCount < 1_000) return '1-999';
  if (rowCount < 10_000) return '1000-9999';
  if (rowCount < 100_000) return '10000-99999';
  return '100000+';
}

function rows(dataset: DatasetName): unknown[][] {
  const rowCount = datasetRows[dataset];
  return Array.from({ length: rowCount }, (_, index) => [
    String(index),
    dataset === 'high-cardinality' ? `unique-${index}` : `label-${index % 1_000}`,
    index % 2 === 0,
  ]);
}

function jsonlBuffer(inputRows: readonly unknown[][]): Buffer {
  const payload = [
    JSON.stringify({ kind: 'columns', columns }),
    ...inputRows.map((row) => JSON.stringify({ kind: 'record', row })),
    '',
  ].join('\n');
  return zstdCompressSync(Buffer.from(payload));
}

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]!;
}

function median(values: readonly number[]): number {
  return percentile(values, 0.5);
}

async function directoryBytes(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(path);
    else total += (await stat(path)).size;
  }
  return total;
}

async function runJsonlProfile(jsonl: Buffer, fallback: boolean): Promise<BenchmarkRun> {
  const startedAt = performance.now();
  const cursor = await openPersistedResult(Readable.from(jsonl), {
    format: 'jsonl.zst',
    key: 'benchmark.jsonl.zst',
  });
  const profile = await profileRowsStream(cursor.columns, cursor.rows);
  const durationMs = performance.now() - startedAt;
  return {
    rowCount: profile.rowCount,
    queueWaitMs: 0,
    duckdbDurationMs: 0,
    jsonlFallbackDurationMs: fallback ? durationMs : 0,
  };
}

async function runDuckdbProfile(parquetPath: string): Promise<BenchmarkRun> {
  const instance = await (await import('@duckdb/node-api')).DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  try {
    const startedAt = performance.now();
    const profile = await profileDuckdbParquetRows(connection, parquetPath, columns);
    return {
      rowCount: profile.rowCount,
      queueWaitMs: 0,
      duckdbDurationMs: performance.now() - startedAt,
      jsonlFallbackDurationMs: 0,
    };
  } finally {
    connection.disconnectSync();
    instance.closeSync();
  }
}

async function measure(
  action: () => Promise<BenchmarkRun>,
  warmup: number,
  repeats: number,
): Promise<{ durationsMs: number[]; runs: BenchmarkRun[] }> {
  for (let index = 0; index < warmup; index++) await action();
  const durationsMs: number[] = [];
  const runs: BenchmarkRun[] = [];
  for (let index = 0; index < repeats; index++) {
    const startedAt = performance.now();
    runs.push(await action());
    durationsMs.push(performance.now() - startedAt);
  }
  return { durationsMs, runs };
}

async function measureCase(input: {
  directory: string;
  dataset: DatasetName;
  mode: BenchmarkMode;
  temperature: Temperature;
  action: () => Promise<BenchmarkRun>;
  warmup: number;
  repeats: number;
  rowCount: number;
  fallbackReason: string;
}): Promise<BenchmarkCase> {
  const beforeRss = process.memoryUsage().rss;
  const measurement = await measure(input.action, input.warmup, input.repeats);
  const afterRss = process.memoryUsage().rss;
  const p50Ms = percentile(measurement.durationsMs, 0.5);
  const tempBytes = await directoryBytes(input.directory);
  return {
    dataset: input.dataset,
    mode: input.mode,
    temperature: input.temperature,
    rowCount: input.rowCount,
    rowCountBucket: rowCountBucket(input.rowCount),
    fallbackReason: input.fallbackReason,
    repeats: measurement.durationsMs.length,
    p50Ms,
    p95Ms: percentile(measurement.durationsMs, 0.95),
    rowsPerSecondP50: Math.round(input.rowCount / (p50Ms / 1_000)),
    queueWaitMs: median(measurement.runs.map((run) => run.queueWaitMs)),
    duckdbDurationMs: median(measurement.runs.map((run) => run.duckdbDurationMs)),
    jsonlFallbackDurationMs: median(measurement.runs.map((run) => run.jsonlFallbackDurationMs)),
    peakRssBytes: Math.max(beforeRss, afterRss),
    tempBytes,
  };
}

async function main(): Promise<void> {
  if (ROW_COUNT_OVERRIDE < 0 || !Number.isSafeInteger(ROW_COUNT_OVERRIDE)) {
    throw new Error('DUCKDB_PROFILE_BENCH_ROWS must be a non-negative safe integer');
  }
  if (
    !Number.isSafeInteger(WARMUP) ||
    WARMUP < 0 ||
    !Number.isSafeInteger(REPEATS) ||
    REPEATS <= 0
  ) {
    throw new Error('benchmark warmup/repeats are invalid');
  }
  const datasets: DatasetName[] = DATASET_FILTER
    ? [DATASET_FILTER]
    : ['small', 'medium', 'large', 'high-cardinality'];
  if (datasets.some((dataset) => !(dataset in datasetRows))) {
    throw new Error('DUCKDB_PROFILE_BENCH_DATASET is invalid');
  }

  const cases: BenchmarkCase[] = [];
  const artifactBytes: Record<string, { jsonlZstdBytes: number; parquetBytes: number }> = {};
  const directory = await mkdtemp(join(tmpdir(), 'hubble-duckdb-profile-bench-'));
  try {
    for (const dataset of datasets) {
      const inputRows = rows(dataset);
      const jsonl = jsonlBuffer(inputRows);
      const parquetPath = join(directory, dataset + '.parquet');
      await convertJsonlToParquet({
        source: Readable.from(jsonl),
        sourceFormat: 'jsonl.zst',
        columns,
        expectedRowCount: inputRows.length,
        outputPath: parquetPath,
      });
      const parquet = await readFile(parquetPath);
      artifactBytes[dataset] = {
        jsonlZstdBytes: jsonl.byteLength,
        parquetBytes: parquet.byteLength,
      };
      const rowCount = inputRows.length;

      cases.push(
        await measureCase({
          directory,
          dataset,
          mode: 'jsonl-zstd',
          temperature: 'cold',
          action: () => runJsonlProfile(jsonl, false),
          warmup: 0,
          repeats: 1,
          rowCount,
          fallbackReason: 'none',
        }),
        await measureCase({
          directory,
          dataset,
          mode: 'jsonl-zstd',
          temperature: 'warm',
          action: () => runJsonlProfile(jsonl, false),
          warmup: WARMUP,
          repeats: REPEATS,
          rowCount,
          fallbackReason: 'none',
        }),
        await measureCase({
          directory,
          dataset,
          mode: 'jsonl-fallback',
          temperature: 'cold',
          action: () => runJsonlProfile(jsonl, true),
          warmup: 0,
          repeats: 1,
          rowCount,
          fallbackReason: 'benchmark_controlled_auth',
        }),
        await measureCase({
          directory,
          dataset,
          mode: 'jsonl-fallback',
          temperature: 'warm',
          action: () => runJsonlProfile(jsonl, true),
          warmup: WARMUP,
          repeats: REPEATS,
          rowCount,
          fallbackReason: 'benchmark_controlled_auth',
        }),
        await measureCase({
          directory,
          dataset,
          mode: 'duckdb-parquet',
          temperature: 'cold',
          action: () => runDuckdbProfile(parquetPath),
          warmup: 0,
          repeats: 1,
          rowCount,
          fallbackReason: 'none',
        }),
        await measureCase({
          directory,
          dataset,
          mode: 'duckdb-parquet',
          temperature: 'warm',
          action: () => runDuckdbProfile(parquetPath),
          warmup: WARMUP,
          repeats: REPEATS,
          rowCount,
          fallbackReason: 'none',
        }),
      );
    }

    console.info(
      JSON.stringify(
        {
          schemaVersion: 'e-hardening-profile-benchmark-v1',
          benchmark: 'duckdb-persisted-profile-rollout-evidence',
          warmup: WARMUP,
          repeats: REPEATS,
          columns: columns.length,
          artifacts: artifactBytes,
          cases,
          limitations: [
            'local core comparison only; S3 network and metadata validation are excluded',
            'cold includes fresh DuckDB instance creation; warm still creates one instance per sample',
            'queueWaitMs is zero because this benchmark runs without concurrent admission pressure',
            'peakRssBytes is sampled before and after each case, not a native heap trace',
            'tempBytes is the observed benchmark temporary directory size and does not prove spill absence',
            'fallback duration uses a controlled auth fallback label and does not measure a live route',
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

await main();
