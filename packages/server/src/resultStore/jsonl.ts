/**
 * 圧縮 JSONL 形式のクエリ結果ストリームを読み書きするヘルパー。
 */
import { constants as zlibConstants, createZstdCompress, createZstdDecompress } from 'node:zlib';
import { Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import { queryColumnSchema, type QueryColumn } from '@hubble/contracts';
import { csvRecord } from '../query/csv';
import type { QueryResultEvent } from '../query/resultEvents';
import type { ResultStore } from './store';
import { createSqlAbortError } from '../engine/sql/abort';

type ResultJsonlLine =
  | { kind: 'columns'; columns: QueryColumn[] }
  | { kind: 'record'; row: unknown[] };

/** 保存済み結果を読むときの制御情報。 */
export interface PersistedResultReadOptions {
  /** 圧縮ストリームの読み取りを中断するシグナル。 */
  signal?: AbortSignal;
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
  private readonly upload: Promise<void>;
  private writeTail: Promise<void> = Promise.resolve();
  private closed = false;
  private sawColumns = false;
  private failure?: unknown;

  constructor(
    private readonly store: ResultStore,
    readonly key: string,
  ) {
    this.input = createZstdCompress({
      params: { [zlibConstants.ZSTD_c_compressionLevel]: 3 },
    });
    this.upload = Promise.resolve()
      .then(() => this.store.put(this.key, this.input))
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
    if (!this.sawColumns) this.writeColumns([]);
    await this.writeTail;
    this.closed = true;
    if (this.failure === undefined) {
      this.input.end();
    } else {
      this.input.destroy();
    }
    await this.upload;
    if (this.failure !== undefined) throw this.failure;
  }

  /** 異常終了時にアップロードを破棄する。 */
  async abort(): Promise<void> {
    this.closed = true;
    this.input.destroy();
    await this.writeTail;
    await this.upload;
  }

  private enqueue(lines: ResultJsonlLine[]): Promise<void> {
    if (this.closed || this.failure !== undefined || lines.length === 0) {
      return Promise.resolve();
    }
    this.writeTail = this.writeTail
      .then(async () => {
        for (const line of lines) {
          if (this.closed || this.failure !== undefined) return;
          await this.write(`${JSON.stringify(line)}\n`);
        }
      })
      .catch((err: unknown) => {
        this.markFailed(err);
      });
    return this.writeTail;
  }

  private async write(payload: string): Promise<void> {
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
    if (this.failure !== undefined) return;
    this.failure = err;
    this.input.destroy();
  }
}

/** 圧縮 JSONL から指定ページの行を読み取る。 */
export async function readPersistedRowsPage(
  stream: Readable,
  offset: number,
  limit: number,
  options: ReadPersistedRowsPageOptions = {},
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
