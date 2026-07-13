/**
 * A2 Parquet artifact の行を DuckDB から streaming で供給する reader。
 *
 * profile の意味論は既存の profileRowsStream に委譲する。
 * DuckDB は Parquet の schema と metadata を検証し、物理列を c0000 形式で
 * 読み出すだけに限定する。SQL aggregate はこの経路では使わない。
 */
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import type { QueryColumn, ResultProfile } from '@hubble/contracts';
import { createDuckdbS3TemporarySecret, validateDuckdbS3Scope } from './duckdbS3';
import { profileRowsStream } from '../query/exploration';
import { buildResultParquetObjectKey } from '../store/resultParquetConversionJobs';

const PROFILE_ENCODING_VERSION = '1';
const DEFAULT_CONCURRENCY = 1;
const DEFAULT_WAIT_TIMEOUT_MS = 100;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MEMORY_LIMIT = '256MB';
const DEFAULT_MAX_TEMP_DIRECTORY_SIZE = '1GB';
const SUPPORTED_COLUMN_TYPE =
  /^(boolean|tinyint|smallint|integer|int|bigint|real|float|double|double precision|char(?:\(\d+\))?|varchar(?:\(\d+\))?|text)$/i;
type DuckdbProfileAbortSource = 'external' | 'timeout';

function hasUnsafeS3PrefixCharacter(prefix: string): boolean {
  return Array.from(prefix).some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

/** DuckDB profile の適用外理由。 */
export type DuckdbProfileEligibilityReason =
  | 'unsupported_encoding'
  | 'missing_columns'
  | 'expired_parquet'
  | 'object_key_mismatch'
  | 'invalid_s3_prefix'
  | 'invalid_object_key'
  | 'invalid_row_count'
  | 'unsupported_column_type'
  | 'overloaded'
  | 'disabled';

/** DuckDB 実行失敗の分類。 */
export type DuckdbProfileFailureCode =
  | 'auth'
  | 'httpfs'
  | 's3'
  | 'timeout'
  | 'schema_mismatch'
  | 'duckdb_error'
  | 'overloaded'
  | 'aborted';

/** Parquet metadata の row_count を safe integer として解釈する。 */
export function parseSafeDuckdbRowCount(value: string | undefined): number | undefined {
  if (value === undefined || !/^(?:0|[1-9][0-9]*)$/.test(value)) return undefined;
  const rowCount = Number(value);
  return Number.isSafeInteger(rowCount) ? rowCount : undefined;
}

/** 外部依存の失敗を route が安全に fallback するための構造化エラー。 */
export class DuckdbProfileError extends Error {
  readonly code: DuckdbProfileFailureCode;

  constructor(code: DuckdbProfileFailureCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'DuckdbProfileError';
    this.code = code;
  }
}

/** 認可済み履歴行から組み立てた Parquet profile reader の入力。 */
export interface DuckdbProfileInput {
  historyId: string;
  objectKey: string;
  parquetExpiresAt: string;
  rowCount: number;
  columns: readonly QueryColumn[];
  bucket: string;
  prefix: string;
  region?: string;
  endpoint?: string;
  encodingVersion: string;
  signal?: AbortSignal;
  /** reader の semaphore 待機と DuckDB 区間を呼び出し元へ返す。 */
  timingObserver?: (timing: DuckdbProfileTiming) => void;
}

/** profile reader の resource admission と DuckDB 実行時間。 */
export interface DuckdbProfileTiming {
  queueWaitMs: number;
  duckdbDurationMs: number;
}

/** DuckDB profile reader。テストでは reader 全体を差し替えられる。 */
export type DuckdbPersistedProfileReader = (
  input: DuckdbProfileInput,
) => Promise<ResultProfile | undefined>;

/** DuckDB instance の生成だけを差し替える注入ポイント。 */
export interface DuckdbProfileDeps {
  enabled?: boolean;
  concurrency?: number;
  waitTimeoutMs?: number;
  timeoutMs?: number;
  createInstance?: (options: {
    threads: string;
    memory_limit: string;
    temp_directory: string;
    max_temp_directory_size: string;
  }) => Promise<DuckDBInstance>;
}

/** 物理列名を列順から生成する。表示名や型は SQL identifier に使わない。 */
export function physicalDuckdbColumnName(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new Error('Invalid DuckDB profile column index: ' + index);
  }
  return 'c' + String(index).padStart(4, '0');
}

/** Parquet metadata の履歴照合に使う physical type を返す。 */
export function expectedDuckdbPhysicalType(type: string): string | undefined {
  const normalized = type.trim().toLowerCase();
  if (normalized === 'boolean') return 'BOOLEAN';
  if (normalized === 'tinyint') return 'TINYINT';
  if (normalized === 'smallint') return 'SMALLINT';
  if (normalized === 'integer' || normalized === 'int') return 'INTEGER';
  if (normalized === 'bigint') return 'BIGINT';
  if (normalized === 'real' || normalized === 'float') return 'FLOAT';
  if (normalized === 'double' || normalized === 'double precision') return 'DOUBLE';
  if (/^(?:char|varchar|text)(?:\(\d+\))?$/.test(normalized)) return 'VARCHAR';
  return undefined;
}

/** input の適用可否を純関数で判定する。 */
export function getDuckdbProfileEligibility(
  input: DuckdbProfileInput,
  now = Date.now(),
): { eligible: true } | { eligible: false; reason: DuckdbProfileEligibilityReason } {
  if (input.encodingVersion !== PROFILE_ENCODING_VERSION) {
    return { eligible: false, reason: 'unsupported_encoding' };
  }
  if (input.columns.length === 0) return { eligible: false, reason: 'missing_columns' };
  if (!Number.isSafeInteger(input.rowCount) || input.rowCount < 0) {
    return { eligible: false, reason: 'invalid_row_count' };
  }
  const parquetExpiresAt = new Date(input.parquetExpiresAt).getTime();
  if (!Number.isFinite(parquetExpiresAt) || parquetExpiresAt <= now) {
    return { eligible: false, reason: 'expired_parquet' };
  }
  if (input.prefix === '' || !input.prefix.endsWith('/')) {
    return { eligible: false, reason: 'invalid_s3_prefix' };
  }
  if (
    !/^[a-z0-9](?:[a-z0-9.-]{1,61})[a-z0-9]$/.test(input.bucket) ||
    input.bucket.includes('..') ||
    (input.region ?? 'us-east-1').trim() === '' ||
    input.prefix.includes('?') ||
    input.prefix.includes('#') ||
    input.prefix.includes('\\') ||
    hasUnsafeS3PrefixCharacter(input.prefix)
  ) {
    return { eligible: false, reason: 'invalid_s3_prefix' };
  }
  if (
    !/^[A-Za-z0-9_-]+$/.test(input.historyId) ||
    input.objectKey.trim() === '' ||
    input.objectKey.startsWith('/') ||
    input.objectKey.includes('?') ||
    input.objectKey.includes('#') ||
    input.objectKey.split('/').some((part) => part === '..')
  ) {
    return { eligible: false, reason: 'invalid_object_key' };
  }
  if (input.objectKey !== buildResultParquetObjectKey(input.prefix, input.historyId)) {
    return { eligible: false, reason: 'object_key_mismatch' };
  }
  if (input.columns.some((column) => !SUPPORTED_COLUMN_TYPE.test(column.type.trim()))) {
    return { eligible: false, reason: 'unsupported_column_type' };
  }
  return { eligible: true };
}

/** SQL の identifier に入る physical 列リストを生成する。 */
export function buildDuckdbProfileSelectSql(columnCount: number): string {
  if (!Number.isSafeInteger(columnCount) || columnCount <= 0) {
    throw new Error('DuckDB profile requires at least one column');
  }
  const columns = Array.from({ length: columnCount }, (_, index) =>
    physicalDuckdbColumnName(index),
  );
  return 'SELECT ' + columns.join(', ') + ' FROM read_parquet(?)';
}

/** S3 object URI と temporary secret scope を作る。 */
export function buildDuckdbProfileS3Uris(input: DuckdbProfileInput): {
  objectUri: string;
  scope: string;
} {
  const eligibility = getDuckdbProfileEligibility(input);
  if (!eligibility.eligible) {
    throw new Error('DuckDB profile input is not eligible: ' + eligibility.reason);
  }
  const scope = 's3://' + input.bucket + '/' + input.prefix;
  try {
    validateDuckdbS3Scope(scope);
    const object = new URL('s3://' + input.bucket + '/' + input.objectKey);
    if (
      object.protocol !== 's3:' ||
      object.hostname !== input.bucket ||
      object.search !== '' ||
      object.hash !== ''
    ) {
      throw new Error('invalid object URI');
    }
  } catch (error) {
    throw new Error('DuckDB profile S3 URI validation failed', { cause: error });
  }
  return {
    objectUri: 's3://' + input.bucket + '/' + input.objectKey,
    scope,
  };
}

interface ParquetMetadata {
  columns: Array<{ name: string; type: string }>;
  encodingVersion: string;
  rowCount: number;
}

interface SemaphoreWaiter {
  done: boolean;
  timer: ReturnType<typeof setTimeout>;
  resolve: (release: (() => void) | undefined) => void;
  reject: (error: unknown) => void;
  onAbort?: () => void;
}

class DuckdbProfileSemaphore {
  private available: number;
  private readonly waiters: SemaphoreWaiter[] = [];

  constructor(concurrency: number) {
    if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
      throw new Error('DuckDB profile concurrency must be positive');
    }
    this.available = concurrency;
  }

  async acquire(
    signal: AbortSignal | undefined,
    waitTimeoutMs: number,
  ): Promise<(() => void) | undefined> {
    if (signal?.aborted) throw new DuckdbProfileError('aborted', 'DuckDB profile request aborted');
    if (this.available > 0) {
      this.available -= 1;
      return this.createRelease();
    }
    return new Promise<(() => void) | undefined>((resolve, reject) => {
      const waiter = {} as SemaphoreWaiter;
      const finish = (callback: () => void): void => {
        if (waiter.done) return;
        waiter.done = true;
        clearTimeout(waiter.timer);
        if (waiter.onAbort !== undefined) signal?.removeEventListener('abort', waiter.onAbort);
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        callback();
      };
      waiter.done = false;
      waiter.resolve = (release) => finish(() => resolve(release));
      waiter.reject = (error) => finish(() => reject(error));
      waiter.timer = setTimeout(() => waiter.resolve(undefined), waitTimeoutMs);
      waiter.onAbort = () =>
        waiter.reject(new DuckdbProfileError('aborted', 'DuckDB profile request aborted'));
      signal?.addEventListener('abort', waiter.onAbort, { once: true });
      this.waiters.push(waiter);
      this.drain();
    });
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.available += 1;
      this.drain();
    };
  }

  private drain(): void {
    if (this.available <= 0) return;
    const waiter = this.waiters[0];
    if (waiter === undefined) return;
    this.available -= 1;
    waiter.resolve(this.createRelease());
  }
}

function createSecretName(): string {
  return (
    'profile_secret_' + process.pid + '_' + Date.now() + '_' + Math.floor(Math.random() * 1_000_000)
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'CanceledError');
}

function wrapExternal<T>(
  code: DuckdbProfileFailureCode,
  action: () => Promise<T>,
  message: string,
): Promise<T> {
  return action().catch((error: unknown) => {
    if (error instanceof DuckdbProfileError) throw error;
    throw new DuckdbProfileError(code, message, error);
  });
}

async function readDuckdbMetadataRows(
  connection: DuckDBConnection,
  sql: string,
  objectUri: string,
  message: string,
): Promise<unknown[][]> {
  const result = await wrapExternal('s3', () => connection.stream(sql, [objectUri]), message);
  const rows: unknown[][] = [];
  try {
    for await (const chunk of result.yieldRowsJson()) {
      rows.push(...(chunk as unknown[][]));
    }
  } catch (error) {
    throw new DuckdbProfileError('s3', message, error);
  }
  return rows;
}

async function readParquetMetadata(
  connection: DuckDBConnection,
  objectUri: string,
  input: DuckdbProfileInput,
): Promise<ParquetMetadata> {
  const schemaRows = await readDuckdbMetadataRows(
    connection,
    'DESCRIBE SELECT * FROM read_parquet(?)',
    objectUri,
    'Parquet schema could not be read',
  );
  const columns = schemaRows.map((row) => ({
    name: String(row[0]),
    type: String(row[1]).toUpperCase(),
  }));
  if (
    columns.length !== input.columns.length ||
    columns.some(
      (column, index) =>
        column.name !== physicalDuckdbColumnName(index) ||
        column.type !== expectedDuckdbPhysicalType(input.columns[index]!.type),
    )
  ) {
    throw new DuckdbProfileError(
      'schema_mismatch',
      'Parquet physical schema does not match persisted result metadata',
    );
  }

  const metadataRows = await readDuckdbMetadataRows(
    connection,
    'SELECT key, value FROM parquet_kv_metadata(?)',
    objectUri,
    'Parquet metadata could not be read',
  );
  const metadata = new Map(metadataRows.map((row) => [String(row[0]), String(row[1])]));
  const encodingVersion = metadata.get('hubble.encoding_version');
  const rowCountText = metadata.get('hubble.row_count');
  const rowCount = parseSafeDuckdbRowCount(rowCountText);
  if (
    encodingVersion !== PROFILE_ENCODING_VERSION ||
    rowCount === undefined ||
    rowCount !== input.rowCount
  ) {
    throw new DuckdbProfileError(
      'schema_mismatch',
      'Parquet metadata does not match persisted result metadata',
    );
  }
  return { columns, encodingVersion, rowCount };
}

async function* streamParquetRows(
  connection: DuckDBConnection,
  objectUri: string,
  columnCount: number,
  signal: AbortSignal | undefined,
): AsyncGenerator<unknown[]> {
  if (signal?.aborted) throw new DuckdbProfileError('aborted', 'DuckDB profile request aborted');
  let result;
  try {
    result = await connection.stream(buildDuckdbProfileSelectSql(columnCount), [objectUri]);
  } catch (error) {
    throw new DuckdbProfileError('s3', 'DuckDB Parquet row stream could not be opened', error);
  }
  try {
    for await (const chunk of result.yieldRowsJson()) {
      if (signal?.aborted) {
        connection.interrupt();
        throw new DuckdbProfileError('aborted', 'DuckDB profile request aborted');
      }
      for (const row of chunk) yield row as unknown[];
    }
  } catch (error) {
    if (error instanceof DuckdbProfileError) throw error;
    if (signal?.aborted || isAbortError(error)) {
      throw new DuckdbProfileError('aborted', 'DuckDB profile request aborted', error);
    }
    throw new DuckdbProfileError('s3', 'DuckDB Parquet row stream failed', error);
  }
}

/** DuckDB の local/S3 URI から rows を streaming で profileRowsStream へ渡す。 */
export async function profileDuckdbParquetRows(
  connection: DuckDBConnection,
  objectUri: string,
  columns: readonly QueryColumn[],
  signal?: AbortSignal,
): Promise<ResultProfile> {
  const profiled = await profileRowsStream(
    [...columns],
    streamParquetRows(connection, objectUri, columns.length, signal),
  );
  return {
    rowCount: profiled.rowCount,
    complete: true,
    columns: profiled.profiles,
  };
}

/** fresh DuckDB で Parquet rows を読み、profileRowsStream へ再利用する reader を作る。 */
export function createDuckdbPersistedProfileReader(
  deps: DuckdbProfileDeps = {},
): DuckdbPersistedProfileReader {
  const enabled = deps.enabled ?? false;
  const concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;
  const waitTimeoutMs = deps.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const createInstance =
    deps.createInstance ??
    ((options: {
      threads: string;
      memory_limit: string;
      temp_directory: string;
      max_temp_directory_size: string;
    }) => DuckDBInstance.create(':memory:', options));
  const semaphore = new DuckdbProfileSemaphore(concurrency);

  return async (input) => {
    if (!enabled) return undefined;
    const eligibility = getDuckdbProfileEligibility(input);
    if (!eligibility.eligible) return undefined;
    const queueStartedAt = Date.now();
    let queueWaitMs = 0;
    const duckdbStartedAt: { value: number | undefined } = { value: undefined };
    let timingReported = false;
    const reportTiming = (): void => {
      if (timingReported) return;
      timingReported = true;
      try {
        input.timingObserver?.({
          queueWaitMs,
          duckdbDurationMs:
            duckdbStartedAt.value === undefined
              ? 0
              : Math.max(0, Date.now() - duckdbStartedAt.value),
        });
      } catch {
        // timing 通知の失敗で profile reader の結果を変えない。
      }
    };
    let release: (() => void) | undefined;
    try {
      release = await semaphore.acquire(input.signal, waitTimeoutMs);
      queueWaitMs = Math.max(0, Date.now() - queueStartedAt);
    } catch (error) {
      queueWaitMs = Math.max(0, Date.now() - queueStartedAt);
      reportTiming();
      throw error;
    }
    if (release === undefined) {
      reportTiming();
      throw new DuckdbProfileError('overloaded', 'DuckDB profile concurrency limit reached');
    }
    duckdbStartedAt.value = Date.now();

    let tempDirectory: string | undefined;
    const controller = new AbortController();
    let connection: DuckDBConnection | undefined;
    let instance: DuckDBInstance | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abortSource: DuckdbProfileAbortSource | undefined;
    let failure: unknown;
    let result: ResultProfile | undefined;
    const onAbort = (): void => {
      if (abortSource === undefined) abortSource = 'external';
      controller.abort();
      try {
        connection?.interrupt();
      } catch {
        // DuckDB が終了処理へ入った後の interrupt 失敗は cleanup で扱う。
      }
    };
    try {
      tempDirectory = mkdtempSync(join(tmpdir(), 'hubble-duckdb-profile-'));
      input.signal?.addEventListener('abort', onAbort, { once: true });
      if (input.signal?.aborted) {
        onAbort();
        throw new DuckdbProfileError('aborted', 'DuckDB profile request aborted');
      }
      timeout = setTimeout(() => {
        if (abortSource === undefined) abortSource = 'timeout';
        controller.abort();
        try {
          connection?.interrupt();
        } catch {
          // DuckDB が終了処理へ入った後の interrupt 失敗は cleanup で扱う。
        }
      }, timeoutMs);

      instance = await wrapExternal(
        'duckdb_error',
        () =>
          createInstance({
            threads: '1',
            memory_limit: DEFAULT_MEMORY_LIMIT,
            temp_directory: tempDirectory!,
            max_temp_directory_size: DEFAULT_MAX_TEMP_DIRECTORY_SIZE,
          }),
        'DuckDB profile instance could not be created',
      );
      connection = await wrapExternal(
        'duckdb_error',
        () => instance!.connect(),
        'DuckDB profile connection could not be created',
      );
      await wrapExternal(
        'httpfs',
        () => connection!.run('SET autoload_known_extensions = false'),
        'DuckDB profile extension settings could not be applied',
      );
      await wrapExternal(
        'httpfs',
        () => connection!.run('SET autoinstall_known_extensions = false'),
        'DuckDB profile extension settings could not be applied',
      );
      await wrapExternal(
        'httpfs',
        () => connection!.run('LOAD aws'),
        'DuckDB aws extension could not be loaded',
      );
      await wrapExternal(
        'httpfs',
        () => connection!.run('LOAD httpfs'),
        'DuckDB httpfs extension could not be loaded',
      );
      const { objectUri, scope } = buildDuckdbProfileS3Uris(input);
      await wrapExternal(
        'auth',
        () =>
          createDuckdbS3TemporarySecret(connection!, {
            name: createSecretName(),
            scope,
            region: input.region ?? 'us-east-1',
            endpoint: input.endpoint,
          }),
        'DuckDB profile credential secret could not be created',
      );
      await wrapExternal(
        'schema_mismatch',
        () => readParquetMetadata(connection!, objectUri, input),
        'Parquet metadata could not be validated',
      );
      const profile = await profileDuckdbParquetRows(
        connection!,
        objectUri,
        input.columns,
        controller.signal,
      );
      if (abortSource === 'external') {
        throw new DuckdbProfileError('aborted', 'DuckDB profile request aborted');
      }
      if (abortSource === 'timeout') {
        throw new DuckdbProfileError('timeout', 'DuckDB profile timed out');
      }
      if (profile.rowCount !== input.rowCount) {
        throw new DuckdbProfileError(
          'schema_mismatch',
          'Parquet row count differs from persisted result metadata',
        );
      }
      result = profile;
    } catch (error) {
      if (abortSource === 'external') {
        failure = new DuckdbProfileError('aborted', 'DuckDB profile request aborted', error);
      } else if (abortSource === 'timeout') {
        failure = new DuckdbProfileError('timeout', 'DuckDB profile timed out', error);
      } else {
        failure = error;
      }
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      input.signal?.removeEventListener('abort', onAbort);
      try {
        connection?.disconnectSync();
      } catch (error) {
        if (failure === undefined)
          failure = new DuckdbProfileError(
            'duckdb_error',
            'DuckDB profile connection cleanup failed',
            error,
          );
      }
      try {
        instance?.closeSync();
      } catch (error) {
        if (failure === undefined)
          failure = new DuckdbProfileError(
            'duckdb_error',
            'DuckDB profile instance cleanup failed',
            error,
          );
      }
      if (tempDirectory !== undefined) {
        try {
          await rm(tempDirectory, { recursive: true, force: true });
        } catch (error) {
          if (failure === undefined) {
            failure = new DuckdbProfileError(
              'duckdb_error',
              'DuckDB profile temp cleanup failed',
              error,
            );
          }
        }
      }
      release();
      reportTiming();
    }
    if (failure !== undefined) throw failure;
    return result;
  };
}
