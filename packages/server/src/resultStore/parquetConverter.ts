/**
 * 圧縮 JSONL を bounded streaming で Parquet へ変換する kernel。
 *
 * 表示名は SQL identifier として使わず、列順だけを表す固定名へ変換する。
 * 表示名と論理型は履歴に保存された QueryColumn を正とし、DuckDB の physical
 * schema はこの kernel 内でのみ使う。
 */
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DuckDBInstance, type DuckDBAppender, type DuckDBConnection } from '@duckdb/node-api';
import type { QueryColumn } from '@hubble/contracts';
import { Readable } from 'node:stream';
import { openPersistedResult, type ResultFormat } from './jsonl';

/** converter が分類して返すエラーコード。 */
export type ParquetConverterErrorCode =
  | 'unsupported_type'
  | 'invalid_value'
  | 'malformed_row'
  | 'row_count_mismatch'
  | 'aborted'
  | 'timed_out'
  | 'duckdb_error';

/** 後続 worker が retry/dead 判定に使える converter error。 */
export class ParquetConverterError extends Error {
  readonly code: ParquetConverterErrorCode;
  readonly permanent: boolean;

  constructor(
    code: ParquetConverterErrorCode,
    message: string,
    options: { cause?: unknown; permanent?: boolean } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ParquetConverterError';
    this.code = code;
    this.permanent =
      options.permanent ?? (code !== 'aborted' && code !== 'timed_out' && code !== 'duckdb_error');
  }
}

/** DuckDB kernel の resource limit。既定値は server process の RAM を使い切らない。 */
export interface ParquetConverterResourceLimits {
  threads?: number;
  memoryLimit?: string;
  maxTempDirectorySize?: string;
  timeoutMs?: number;
  /** 指定時はこの directory を DuckDB の temporary spill 先に使う。 */
  tempDirectory?: string;
}

/** JSONL source から Parquet を作る入力。 */
export interface ParquetConverterInput {
  source: Readable;
  sourceFormat: ResultFormat;
  columns: readonly QueryColumn[];
  expectedRowCount: number;
  outputPath: string;
  resourceLimits?: ParquetConverterResourceLimits;
  signal?: AbortSignal;
}

/** converter の成功結果。 */
export interface ParquetConverterResult {
  outputPath: string;
  rowCount: number;
}

const DEFAULT_THREADS = 1;
const DEFAULT_MEMORY_LIMIT = '256MB';
const DEFAULT_MAX_TEMP_DIRECTORY_SIZE = '1GB';
const DEFAULT_TIMEOUT_MS = 120_000;
const APPENDER_BATCH_SIZE = 1_024;
const ROW_GROUP_SIZE = 10_000;
const INT64_MIN = -(1n << 63n);
const INT64_MAX = (1n << 63n) - 1n;

type ColumnKind =
  | 'boolean'
  | 'tinyint'
  | 'smallint'
  | 'integer'
  | 'bigint'
  | 'real'
  | 'double'
  | 'varchar';

interface ColumnMapping {
  index: number;
  kind: ColumnKind;
  physicalType: string;
}

type AbortSource = 'external' | 'timeout';

/** 圧縮 JSONL を Parquet へ変換する。source の行は一度に batch 件以上保持しない。 */
export async function convertJsonlToParquet(
  input: ParquetConverterInput,
): Promise<ParquetConverterResult> {
  const controller = new AbortController();
  let abortSource: AbortSource | undefined;
  const abortOnce = (source: AbortSource): void => {
    if (abortSource !== undefined) return;
    abortSource = source;
    controller.abort();
  };
  const onAbort = (): void => abortOnce('external');
  input.signal?.addEventListener('abort', onAbort, { once: true });
  if (input.signal?.aborted) onAbort();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let tempDirectory: string | undefined;
  let ownsTempDirectory = false;
  let instance: DuckDBInstance | undefined;
  let connection: DuckDBConnection | undefined;
  let appender: DuckDBAppender | undefined;
  let outputClaimed = false;
  let outputCreated = false;
  let primaryError: unknown;
  let result: ParquetConverterResult | undefined;

  try {
    if (input.signal?.aborted)
      throw new ParquetConverterError('aborted', 'Parquet conversion aborted');
    const mappings = input.columns.map((column, index) => mapColumnType(column.type, index));
    validateInput(input);
    const limits = resolveLimits(input.resourceLimits);
    timeout = setTimeout(() => {
      abortOnce('timeout');
    }, limits.timeoutMs);
    tempDirectory = limits.tempDirectory;
    if (controller.signal.aborted) throw createAbortError(abortSource);
    if (tempDirectory === undefined) {
      tempDirectory = mkdtempSync(join(tmpdir(), 'hubble-parquet-converter-'));
      ownsTempDirectory = true;
    } else {
      mkdirSync(tempDirectory, { recursive: true });
    }
    if (existsSync(input.outputPath)) {
      throw new ParquetConverterError(
        'invalid_value',
        `Parquet output already exists: ${input.outputPath}`,
      );
    }
    outputClaimed = true;
    mkdirSync(dirname(input.outputPath), { recursive: true });

    instance = await DuckDBInstance.create(':memory:', {
      threads: String(limits.threads),
      memory_limit: limits.memoryLimit,
      temp_directory: tempDirectory,
      max_temp_directory_size: limits.maxTempDirectorySize,
    });
    connection = await instance.connect();
    const interrupt = (): void => connection?.interrupt();
    controller.signal.addEventListener('abort', interrupt, { once: true });
    try {
      if (controller.signal.aborted) throw createAbortError(abortSource);
      await connection.run(
        `CREATE TABLE converter_input (${mappings.map((item) => `c${String(item.index).padStart(4, '0')} ${item.physicalType}`).join(', ')})`,
      );
      appender = await connection.createAppender('converter_input');
      const cursor = await openPersistedResult(input.source, {
        format: input.sourceFormat,
        signal: controller.signal,
      });
      let observedRowCount = 0;
      for await (const row of cursor.rows) {
        if (controller.signal.aborted) throw createAbortError(abortSource);
        if (row.length !== mappings.length) {
          throw new ParquetConverterError(
            'malformed_row',
            `Persisted row width mismatch at row ${observedRowCount}: expected ${mappings.length}, got ${row.length}`,
          );
        }
        appendRow(appender, mappings, row, observedRowCount);
        observedRowCount += 1;
        if (observedRowCount % APPENDER_BATCH_SIZE === 0) appender.flushSync();
      }
      if (observedRowCount !== input.expectedRowCount) {
        throw new ParquetConverterError(
          'row_count_mismatch',
          `Persisted row count mismatch: expected ${input.expectedRowCount}, got ${observedRowCount}`,
        );
      }
      appender.flushSync();
      appender.closeSync();
      appender = undefined;
      await connection.run(
        `COPY converter_input TO ${sqlString(input.outputPath)} (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE ${ROW_GROUP_SIZE}, KV_METADATA {'hubble.encoding_version':'1','hubble.row_count':'${observedRowCount}'})`,
      );
      outputCreated = true;
    } finally {
      controller.signal.removeEventListener('abort', interrupt);
    }
    result = { outputPath: input.outputPath, rowCount: input.expectedRowCount };
  } catch (error) {
    const convertedError =
      error instanceof ParquetConverterError
        ? abortSource === 'timeout' && error.code === 'aborted'
          ? new ParquetConverterError('timed_out', 'Parquet conversion timed out', {
              cause: error,
            })
          : error
        : abortSource === 'timeout'
          ? new ParquetConverterError('timed_out', 'Parquet conversion timed out', {
              cause: error,
            })
          : abortSource === 'external'
            ? new ParquetConverterError('aborted', 'Parquet conversion aborted', { cause: error })
            : isMalformedResultError(error)
              ? new ParquetConverterError(
                  'malformed_row',
                  'Persisted result contains malformed JSON',
                  { cause: error },
                )
              : new ParquetConverterError('duckdb_error', 'DuckDB Parquet conversion failed', {
                  cause: error,
                  permanent: false,
                });
    primaryError = convertedError;
  }

  const cleanupErrors: unknown[] = [];
  try {
    if (timeout !== undefined) clearTimeout(timeout);
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    input.signal?.removeEventListener('abort', onAbort);
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    input.source.destroy();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    appender?.closeSync();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    connection?.disconnectSync();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    instance?.closeSync();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    if (outputClaimed && !outputCreated) rmSync(input.outputPath, { force: true });
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    if (ownsTempDirectory && tempDirectory !== undefined) {
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (primaryError === undefined && cleanupErrors.length > 0 && outputCreated) {
    try {
      rmSync(input.outputPath, { force: true });
      outputCreated = false;
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (primaryError !== undefined) throw primaryError;
  if (cleanupErrors.length > 0) {
    throw new ParquetConverterError('duckdb_error', 'Parquet conversion cleanup failed', {
      cause: cleanupErrors[0],
      permanent: false,
    });
  }
  if (result === undefined) {
    throw new ParquetConverterError('duckdb_error', 'Parquet conversion did not produce a result', {
      permanent: false,
    });
  }
  return result;
}

function createAbortError(source: AbortSource | undefined): ParquetConverterError {
  return new ParquetConverterError(
    source === 'timeout' ? 'timed_out' : 'aborted',
    source === 'timeout' ? 'Parquet conversion timed out' : 'Parquet conversion aborted',
  );
}

function validateInput(input: ParquetConverterInput): void {
  if (!Number.isSafeInteger(input.expectedRowCount) || input.expectedRowCount < 0) {
    throw new ParquetConverterError(
      'invalid_value',
      `Invalid expected row count: ${input.expectedRowCount}`,
    );
  }
  if (input.columns.length === 0) {
    throw new ParquetConverterError(
      'unsupported_type',
      'Parquet conversion requires at least one column',
    );
  }
}

function resolveLimits(
  input: ParquetConverterResourceLimits | undefined,
): Required<
  Pick<
    ParquetConverterResourceLimits,
    'threads' | 'memoryLimit' | 'maxTempDirectorySize' | 'timeoutMs'
  >
> &
  Pick<ParquetConverterResourceLimits, 'tempDirectory'> {
  const limits = {
    threads: input?.threads ?? DEFAULT_THREADS,
    memoryLimit: input?.memoryLimit ?? DEFAULT_MEMORY_LIMIT,
    maxTempDirectorySize: input?.maxTempDirectorySize ?? DEFAULT_MAX_TEMP_DIRECTORY_SIZE,
    timeoutMs: input?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    tempDirectory: input?.tempDirectory,
  };
  if (!Number.isSafeInteger(limits.threads) || limits.threads <= 0) {
    throw new ParquetConverterError('invalid_value', `Invalid DuckDB threads: ${limits.threads}`);
  }
  if (!Number.isSafeInteger(limits.timeoutMs) || limits.timeoutMs <= 0) {
    throw new ParquetConverterError(
      'invalid_value',
      `Invalid converter timeout: ${limits.timeoutMs}`,
    );
  }
  return limits;
}

function mapColumnType(rawType: string, index: number): ColumnMapping {
  const type = rawType.trim().toLowerCase().replace(/\s+/g, ' ');
  const fixed = (kind: ColumnKind, physicalType: string): ColumnMapping => ({
    index,
    kind,
    physicalType,
  });
  if (type === 'boolean') return fixed('boolean', 'BOOLEAN');
  if (type === 'tinyint') return fixed('tinyint', 'TINYINT');
  if (type === 'smallint') return fixed('smallint', 'SMALLINT');
  if (type === 'integer' || type === 'int') return fixed('integer', 'INTEGER');
  if (type === 'bigint') return fixed('bigint', 'BIGINT');
  if (type === 'real' || type === 'float') return fixed('real', 'REAL');
  if (type === 'double' || type === 'double precision') return fixed('double', 'DOUBLE');
  if (/^(?:char|varchar|text)(?:\(\d+\))?$/.test(type)) return fixed('varchar', 'VARCHAR');
  throw new ParquetConverterError(
    'unsupported_type',
    `Unsupported result column type at c${String(index).padStart(4, '0')}: ${rawType}`,
  );
}

function appendRow(
  appender: DuckDBAppender,
  mappings: readonly ColumnMapping[],
  row: readonly unknown[],
  rowIndex: number,
): void {
  for (const mapping of mappings) {
    const value = row[mapping.index];
    try {
      if (value === null) {
        appender.appendNull();
      } else {
        appendValue(appender, mapping.kind, value);
      }
    } catch (error) {
      if (error instanceof ParquetConverterError) {
        throw new ParquetConverterError(
          error.code,
          `${error.message} at row ${rowIndex}, column ${mapping.index}`,
          { cause: error, permanent: error.permanent },
        );
      }
      throw error;
    }
  }
  appender.endRow();
}

function appendValue(appender: DuckDBAppender, kind: ColumnKind, value: unknown): void {
  switch (kind) {
    case 'boolean':
      if (typeof value !== 'boolean') invalidValue(kind, value);
      appender.appendBoolean(value);
      return;
    case 'tinyint':
      appender.appendTinyInt(integerNumber(value, kind, -128, 127));
      return;
    case 'smallint':
      appender.appendSmallInt(integerNumber(value, kind, -32_768, 32_767));
      return;
    case 'integer':
      appender.appendInteger(integerNumber(value, kind, -2_147_483_648, 2_147_483_647));
      return;
    case 'bigint':
      appender.appendBigInt(integerBigInt(value));
      return;
    case 'real':
      appender.appendFloat(finiteNumber(value, kind));
      return;
    case 'double':
      appender.appendDouble(finiteNumber(value, kind));
      return;
    case 'varchar':
      if (typeof value !== 'string') invalidValue(kind, value);
      appender.appendVarchar(value);
      return;
  }
}

function integerNumber(value: unknown, kind: ColumnKind, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    invalidValue(kind, value);
  }
  return value;
}

function integerBigInt(value: unknown): bigint {
  let result: bigint;
  if (typeof value === 'bigint') {
    result = value;
  } else if (typeof value === 'number' && Number.isSafeInteger(value)) {
    result = BigInt(value);
  } else if (typeof value === 'string' && /^[+-]?\d+$/.test(value)) {
    try {
      result = BigInt(value);
    } catch {
      invalidValue('bigint', value);
    }
  } else {
    invalidValue('bigint', value);
  }
  if (result < INT64_MIN || result > INT64_MAX) invalidValue('bigint', value);
  return result;
}

function finiteNumber(value: unknown, kind: ColumnKind): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalidValue(kind, value);
  return value;
}

function invalidValue(kind: ColumnKind, value: unknown): never {
  throw new ParquetConverterError(
    'invalid_value',
    `Invalid ${kind} value: ${typeof value === 'string' ? value : String(value)}`,
  );
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function isMalformedResultError(error: unknown): boolean {
  return (
    error instanceof SyntaxError ||
    (error instanceof Error && error.message === 'Invalid persisted result JSONL line')
  );
}
