/**
 * 圧縮 JSONL 形式のクエリ結果ストリームを読み書きするヘルパー。
 */
import { constants as zlibConstants, createZstdCompress, createZstdDecompress } from 'node:zlib';
import { Readable, Transform } from 'node:stream';
import { createInterface } from 'node:readline';
import { queryColumnSchema, type QueryColumn } from '@hubble/contracts';
import { csvRecord } from '../query/csv';
import type { QueryResultEvent } from '../query/resultEvents';
import type { ResultStore } from './store';
import { createSqlAbortError } from '../engine/sql/abort';
import {
  defaultResultStoreClock,
  elapsedResultStoreMs,
  resultStoreErrorOutcome,
  safeNotifyResultStoreObserver,
  type ResultStoreClock,
  type ResultStoreMetricOptions,
  type ResultStoreObserver,
} from './observability';

type ResultJsonlLine =
  | { kind: 'columns'; columns: QueryColumn[] }
  | { kind: 'record'; row: unknown[] };

/** zstd writer が一度に投入する JSONL payload の目標上限（UTF-8 bytes）。 */
export const RESULT_JSONL_WRITE_CHUNK_BYTES = 64 * 1024;

/** 保存済み結果を読むときの制御情報。 */
export interface PersistedResultReadOptions {
  /** 圧縮ストリームの読み取りを中断するシグナル。 */
  signal?: AbortSignal;
  /** 読み取り結果を受け取る任意のobserver。 */
  observer?: ResultStoreObserver;
  /** 読み取り時間を測る単調増加時計。 */
  clock?: ResultStoreClock;
}

/** 保存済み結果のページ。 */
export interface PersistedRowsPage {
  columns: QueryColumn[];
  rows: unknown[][];
  totalRows: number;
}

/** 保存済み結果ページを読み取るときに DB 由来の既知情報を渡すオプション。 */
export interface ReadPersistedRowsPageOptions extends PersistedResultReadOptions {
  /** artifact 全体を走査せず返せる、永続化済みの総行数。 */
  totalRows?: number;
  /** 履歴行に保存された列メタデータ。workflow の結果では未指定になり得る。 */
  columns?: QueryColumn[];
}

/** 実行中の結果を zstd 圧縮 JSONL へ流し込む writer。 */
export class ResultJsonlCapture {
  private readonly input: ReturnType<typeof createZstdCompress>;
  private readonly uploadBody: Readable;
  private readonly upload: Promise<void>;
  private readonly observer: ResultStoreObserver | undefined;
  private readonly clock: ResultStoreClock;
  private readonly startedAt: number;
  private writeTail: Promise<void> = Promise.resolve();
  private closed = false;
  private abortRequested = false;
  private sawColumns = false;
  private failure?: unknown;
  private rows = 0;
  private uncompressedBytes = 0;
  private compressedBytes = 0;
  private metricFinalized = false;

  constructor(
    private readonly store: ResultStore,
    readonly key: string,
    options: ResultStoreMetricOptions = {},
  ) {
    this.observer = options.observer;
    this.clock = options.clock ?? defaultResultStoreClock;
    this.startedAt = this.clock();
    this.input = createZstdCompress({
      params: { [zlibConstants.ZSTD_c_compressionLevel]: 3 },
    });
    this.uploadBody = this.createUploadBody();
    this.input.on('error', (err: Error) => this.markFailed(err));
    this.upload = Promise.resolve()
      .then(() => this.store.put(this.key, this.uploadBody))
      .catch((err: unknown) => {
        this.markFailed(err);
      });
  }

  /** 列メタデータ行を書き込む。 */
  writeColumns(columns: QueryColumn[]): void {
    if (this.sawColumns || this.closed || this.failure !== undefined) return;
    this.sawColumns = true;
    this.enqueue([{ kind: 'columns', columns }]);
  }

  /** レコード行を書き込む。 */
  writeRows(rows: unknown[][]): Promise<void> {
    return this.enqueue(rows.map((row) => ({ kind: 'record', row })));
  }

  /** 正常終了として writer を閉じ、アップロード完了を待つ。 */
  async finish(): Promise<void> {
    if (this.abortRequested) {
      await this.upload;
      this.finalizeMetric('abort');
      return;
    }
    if (!this.sawColumns) this.writeColumns([]);
    await this.writeTail;
    this.closed = true;
    if (this.failure === undefined) {
      this.input.end();
    } else {
      this.destroyStreams();
    }
    await this.upload;
    if (this.failure !== undefined) {
      this.finalizeMetric('failure');
      throw this.failure;
    }
    this.finalizeMetric('success');
  }

  /** 異常終了時にアップロードを破棄する。 */
  async abort(): Promise<void> {
    // failure通知が先に確定していても、uploadと書き込みの後始末は待つ。
    if (this.metricFinalized && this.failure === undefined) return;
    this.abortRequested = true;
    this.closed = true;
    this.destroyStreams();
    await this.writeTail;
    await this.upload;
    if (!this.metricFinalized) this.finalizeMetric('abort');
  }

  private enqueue(lines: ResultJsonlLine[]): Promise<void> {
    if (this.closed || this.failure !== undefined || lines.length === 0) {
      return Promise.resolve();
    }
    this.writeTail = this.writeTail
      .then(async () => {
        for (const payload of batchJsonlLines(lines)) {
          if (this.closed || this.failure !== undefined) return;
          await this.write(payload.buffer);
          this.rows += payload.rows;
          this.uncompressedBytes += payload.uncompressedBytes;
        }
      })
      .catch((err: unknown) => {
        this.markFailed(err);
      });
    return this.writeTail;
  }

  private async write(payload: string | Buffer): Promise<void> {
    if (this.input.write(payload)) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        this.input.off('drain', onDrain);
        this.input.off('error', onError);
        this.input.off('close', onClose);
      };
      const onDrain = (): void => {
        cleanup();
        resolve();
      };
      const onError = (err: Error): void => {
        cleanup();
        reject(err);
      };
      const onClose = (): void => {
        cleanup();
        reject(this.failure ?? new Error('Result capture closed before drain'));
      };
      this.input.once('drain', onDrain);
      this.input.once('error', onError);
      this.input.once('close', onClose);
    });
  }

  private markFailed(err: unknown): void {
    if (this.abortRequested || this.metricFinalized) return;
    if (this.failure !== undefined) return;
    this.failure = err;
    this.destroyStreams(err);
    this.finalizeMetric('failure');
  }

  private createUploadBody(): Readable {
    if (!this.observer) return this.input;

    const counter = new Transform({
      readableHighWaterMark: this.input.readableHighWaterMark,
      writableHighWaterMark: this.input.readableHighWaterMark,
      transform: (chunk: Buffer, _encoding, callback): void => {
        this.compressedBytes += chunk.byteLength;
        callback(null, chunk);
      },
    });
    counter.on('error', (err: Error) => this.markFailed(err));
    this.input.pipe(counter);
    return counter;
  }

  private destroyStreams(error?: unknown): void {
    this.input.destroy(error instanceof Error ? error : undefined);
    if (this.uploadBody !== this.input) {
      this.uploadBody.destroy(error instanceof Error ? error : undefined);
    }
  }

  private finalizeMetric(outcome: 'success' | 'failure' | 'abort'): void {
    if (this.metricFinalized) return;
    this.metricFinalized = true;
    safeNotifyResultStoreObserver(this.observer, {
      kind: 'write',
      rows: this.rows,
      uncompressedBytes: this.uncompressedBytes,
      compressedBytes: this.compressedBytes,
      durationMs: elapsedResultStoreMs(this.clock, this.startedAt),
      outcome,
    });
  }
}

/** JSONL の行順を保ったまま、入力ページを bounded payload へまとめる。 */
function* batchJsonlLines(
  lines: ResultJsonlLine[],
): Generator<{ buffer: Buffer; rows: number; uncompressedBytes: number }> {
  const parts: Buffer[] = [];
  let payloadBytes = 0;
  let rows = 0;
  let uncompressedBytes = 0;
  for (const line of lines) {
    const encoded = Buffer.from(`${JSON.stringify(line)}\n`);
    const lineRows = line.kind === 'record' ? 1 : 0;
    let rowCounted = false;
    let offset = 0;
    while (offset < encoded.length) {
      const room = RESULT_JSONL_WRITE_CHUNK_BYTES - payloadBytes;
      const size = Math.min(room, encoded.length - offset);
      parts.push(encoded.subarray(offset, offset + size));
      payloadBytes += size;
      uncompressedBytes += size;
      if (lineRows > 0 && !rowCounted) {
        rows += lineRows;
        rowCounted = true;
      }
      offset += size;
      if (payloadBytes === RESULT_JSONL_WRITE_CHUNK_BYTES) {
        yield { buffer: Buffer.concat(parts, payloadBytes), rows, uncompressedBytes };
        parts.length = 0;
        payloadBytes = 0;
        rows = 0;
        uncompressedBytes = 0;
      }
    }
  }
  if (payloadBytes > 0) {
    yield { buffer: Buffer.concat(parts, payloadBytes), rows, uncompressedBytes };
  }
}

/** 圧縮 JSONL から指定ページの行を読み取る。 */
export async function readPersistedRowsPage(
  stream: Readable,
  offset: number,
  limit: number,
  options: ReadPersistedRowsPageOptions = {},
): Promise<PersistedRowsPage> {
  if (!options.observer) {
    return readPersistedRowsPageImpl(stream, offset, limit, options);
  }

  const clock = options.clock ?? defaultResultStoreClock;
  const startedAt = clock();
  let scannedRows = 0;
  let outcome: 'success' | 'failure' | 'abort' = 'success';
  try {
    return await readPersistedRowsPageImpl(stream, offset, limit, options, () => {
      scannedRows += 1;
    });
  } catch (error) {
    outcome = resultStoreErrorOutcome(error, options.signal);
    throw error;
  } finally {
    safeNotifyResultStoreObserver(options.observer, {
      kind: 'read',
      operation: 'rows',
      scannedRows,
      durationMs: elapsedResultStoreMs(clock, startedAt),
      outcome,
      offset,
    });
  }
}

async function readPersistedRowsPageImpl(
  stream: Readable,
  offset: number,
  limit: number,
  options: ReadPersistedRowsPageOptions,
  onScannedRow?: () => void,
): Promise<PersistedRowsPage> {
  const rows: unknown[][] = [];
  let columns: QueryColumn[] | undefined = options.columns;
  let scannedRows = 0;
  const knownTotalRows =
    options.totalRows !== undefined &&
    Number.isSafeInteger(options.totalRows) &&
    options.totalRows >= 0
      ? options.totalRows
      : undefined;
  const targetEnd =
    knownTotalRows === undefined ? undefined : Math.min(knownTotalRows, offset + limit);
  for await (const line of readResultLines(stream, options.signal)) {
    if (line.kind === 'columns') {
      if (options.columns === undefined) columns = line.columns;
      if (knownTotalRows !== undefined && (limit === 0 || offset >= knownTotalRows)) break;
      continue;
    }
    if (targetEnd !== undefined && scannedRows >= targetEnd) break;
    if (scannedRows >= offset && rows.length < limit) rows.push(line.row);
    scannedRows += 1;
    onScannedRow?.();
    if (targetEnd !== undefined && scannedRows >= targetEnd) break;
  }
  return { columns: columns ?? [], rows, totalRows: knownTotalRows ?? scannedRows };
}

/** 保存済み結果のストリーミング読み出しカーソル。 */
export interface PersistedResultCursor {
  /** 列メタデータ（必ず先頭の columns 行から得る）。 */
  columns: QueryColumn[];
  /** レコード行を 1 行ずつ yield する非同期イテレーター。 */
  rows: AsyncGenerator<unknown[]>;
}

/**
 * 圧縮 JSONL から列情報と行ストリームを取り出す。
 *
 * `readPersistedRowsPage` と違い全行を配列へ materialize せず、行を 1 行ずつ
 * 消費できるカーソルを返す。永続化結果は QUERY_MAX_ROWS で有界ではないため、
 * 全行走査が必要な処理（server-side 探索など）はこちらを使う。
 * writer が作る契約どおり、先頭の columns 行を要求する。
 *
 * @param stream - ResultStore から取得した圧縮 JSONL の Readable。
 * @returns 列メタデータと行の非同期イテレーター。
 */
export async function openPersistedResult(
  stream: Readable,
  options: PersistedResultReadOptions = {},
): Promise<PersistedResultCursor> {
  const lines = readResultLines(stream, options.signal);
  const first = await lines.next();

  if (first.done) throw new Error('Persisted result JSONL is missing columns line');
  if (first.value.kind !== 'columns') {
    throw new Error('Persisted result JSONL must start with a columns line');
  }
  const columns = first.value.columns;

  async function* rows(): AsyncGenerator<unknown[]> {
    for await (const line of lines) {
      if (line.kind === 'record') yield line.row;
    }
  }

  return { columns, rows: rows() };
}

/** 圧縮 JSONL を CSV テキストチャンクへ変換する。 */
export async function* streamPersistedCsv(
  stream: Readable,
  options: PersistedResultReadOptions = {},
): AsyncGenerator<string> {
  for await (const line of readResultLines(stream, options.signal)) {
    if (line.kind === 'columns') {
      if (line.columns.length > 0)
        yield `${csvRecord(line.columns.map((column) => column.name))}\r\n`;
      continue;
    }
    yield `${csvRecord(line.row)}\r\n`;
  }
}

/** 圧縮 JSONL を serializer 非依存の結果イベントへ変換する。 */
export function streamPersistedResultEvents(
  stream: Readable,
  signal?: AbortSignal,
): AsyncGenerator<QueryResultEvent> {
  // generator の最初の next より前に中断されても、既に開いた S3 body を閉じる。
  const abortBeforeStart = (): void => {
    stream.destroy();
  };
  signal?.addEventListener('abort', abortBeforeStart, { once: true });
  if (signal?.aborted) abortBeforeStart();

  return (async function* (): AsyncGenerator<QueryResultEvent> {
    signal?.removeEventListener('abort', abortBeforeStart);
    if (signal?.aborted) throw createSqlAbortError();
    for await (const line of readResultLines(stream, signal)) {
      if (line.kind === 'columns') {
        yield { type: 'columns', columns: line.columns };
        continue;
      }
      yield { type: 'row', row: line.row };
    }
  })();
}

async function* readResultLines(
  stream: Readable,
  signal?: AbortSignal,
): AsyncGenerator<ResultJsonlLine> {
  const decompressor = createZstdDecompress();
  const lines = createInterface({
    input: stream.pipe(decompressor),
    crlfDelay: Infinity,
  });
  const abort = (): void => {
    lines.close();
    decompressor.destroy();
    stream.destroy();
  };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const throwIfAborted = (): void => {
    if (signal?.aborted) throw createSqlAbortError();
  };
  let sawColumns = false;
  try {
    throwIfAborted();
    for await (const raw of lines) {
      throwIfAborted();
      if (raw.trim() === '') continue;
      const parsed = parseLine(raw);
      if (!sawColumns && parsed.kind !== 'columns') {
        throw new Error('Persisted result JSONL must start with a columns line');
      }
      if (sawColumns && parsed.kind === 'columns') {
        throw new Error('Persisted result JSONL contains duplicate columns line');
      }
      sawColumns = true;
      yield parsed;
    }
    throwIfAborted();
    if (!sawColumns) throw new Error('Persisted result JSONL is missing columns line');
  } catch (error: unknown) {
    if (signal?.aborted) throw createSqlAbortError();
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    // page window を満たして途中終了した場合も、S3 body と解凍処理を止める。
    lines.close();
    decompressor.destroy();
    stream.destroy();
  }
  throwIfAborted();
}

function parseLine(line: string): ResultJsonlLine {
  const parsed = JSON.parse(line) as ResultJsonlLine;
  if (parsed.kind === 'columns') {
    const columns = queryColumnSchema.array().safeParse(parsed.columns);
    if (columns.success) return { kind: 'columns', columns: columns.data };
    throw new Error('Invalid persisted result JSONL columns line');
  }
  if (parsed.kind === 'record' && Array.isArray(parsed.row)) {
    return { kind: 'record', row: parsed.row };
  }
  throw new Error('Invalid persisted result JSONL line');
}
