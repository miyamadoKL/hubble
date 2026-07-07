/**
 * gzip JSONL 形式のクエリ結果ストリームを読み書きするヘルパー。
 */
import { createGunzip, createGzip } from 'node:zlib';
import { PassThrough, Readable } from 'node:stream';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import type { QueryColumn } from '@hubble/contracts';
import { csvRecord } from '../query/csv';
import type { QueryResultEvent } from '../query/resultEvents';
import type { ResultStore } from './store';

type ResultJsonlLine =
  | { kind: 'columns'; columns: QueryColumn[] }
  | { kind: 'record'; row: unknown[] };

/** 保存済み結果のページ。 */
export interface PersistedRowsPage {
  columns: QueryColumn[];
  rows: unknown[][];
  totalRows: number;
}

/** 保存済み結果の列メタデータ。 */
export interface PersistedResultMetadata {
  columns: QueryColumn[];
}

/** 実行中の結果を gzip JSONL へ流し込む writer。 */
export class ResultJsonlCapture {
  private readonly input = new PassThrough();
  private readonly upload: Promise<void>;
  private readonly writes: Promise<void>[] = [];
  private closed = false;
  private sawColumns = false;

  constructor(
    private readonly store: ResultStore,
    readonly key: string,
  ) {
    const gzip = createGzip();
    this.upload = this.store.put(this.key, this.input.pipe(gzip));
  }

  /** 列メタデータ行を書き込む。 */
  writeColumns(columns: QueryColumn[]): void {
    if (this.sawColumns) return;
    this.sawColumns = true;
    this.enqueue({ kind: 'columns', columns });
  }

  /** レコード行を書き込む。 */
  writeRows(rows: unknown[][]): void {
    for (const row of rows) {
      this.enqueue({ kind: 'record', row });
    }
  }

  /** 正常終了として writer を閉じ、アップロード完了を待つ。 */
  async finish(): Promise<void> {
    if (!this.sawColumns) this.writeColumns([]);
    await Promise.all(this.writes);
    this.closed = true;
    this.input.end();
    await this.upload;
  }

  /** 異常終了時にアップロードを破棄する。 */
  async abort(): Promise<void> {
    this.closed = true;
    this.input.destroy();
    await this.upload.catch(() => {});
  }

  private enqueue(line: ResultJsonlLine): void {
    if (this.closed) return;
    const payload = `${JSON.stringify(line)}\n`;
    const pending = this.write(payload);
    this.writes.push(pending);
  }

  private async write(payload: string): Promise<void> {
    if (this.input.write(payload)) return;
    await once(this.input, 'drain');
  }
}

/** gzip JSONL から指定ページの行を読み取る。 */
export async function readPersistedRowsPage(
  stream: Readable,
  offset: number,
  limit: number,
): Promise<PersistedRowsPage> {
  const rows: unknown[][] = [];
  let columns: QueryColumn[] = [];
  let totalRows = 0;
  for await (const line of readResultLines(stream)) {
    if (line.kind === 'columns') {
      columns = line.columns;
      continue;
    }
    if (totalRows >= offset && rows.length < limit) rows.push(line.row);
    totalRows += 1;
  }
  return { columns, rows, totalRows };
}

/** 保存済み結果のストリーミング読み出しカーソル。 */
export interface PersistedResultCursor {
  /** 列メタデータ（先頭の columns 行。欠落時は空配列）。 */
  columns: QueryColumn[];
  /** レコード行を 1 行ずつ yield する非同期イテレーター。 */
  rows: AsyncGenerator<unknown[]>;
}

/**
 * gzip JSONL から列情報と行ストリームを取り出す。
 *
 * `readPersistedRowsPage` と違い全行を配列へ materialize せず、行を 1 行ずつ
 * 消費できるカーソルを返す。永続化結果は QUERY_MAX_ROWS で有界ではないため、
 * 全行走査が必要な処理（server-side 探索など）はこちらを使う。
 * writer は常に columns 行を先頭へ書くが、欠落したファイルにも耐えるよう
 * 先頭行がレコードだった場合は columns を空配列とし、その行を行ストリームに含める。
 *
 * @param stream - ResultStore から取得した gzip JSONL の Readable。
 * @returns 列メタデータと行の非同期イテレーター。
 */
export async function openPersistedResult(stream: Readable): Promise<PersistedResultCursor> {
  const lines = readResultLines(stream);
  const first = await lines.next();

  // 先頭行から列情報を決める。バッファするのは最大 1 行なのでメモリは有界。
  let columns: QueryColumn[] = [];
  let firstRow: unknown[] | undefined;
  if (!first.done) {
    if (first.value.kind === 'columns') {
      columns = first.value.columns;
    } else {
      firstRow = first.value.row;
    }
  }

  async function* rows(): AsyncGenerator<unknown[]> {
    if (firstRow) yield firstRow;
    if (first.done) return;
    for await (const line of lines) {
      // 途中の columns 行は（通常は存在しないが）読み飛ばす。
      if (line.kind === 'record') yield line.row;
    }
  }

  return { columns, rows: rows() };
}

/** gzip JSONL の先頭メタ行から列情報を読み取る。 */
export async function readPersistedResultMetadata(
  stream: Readable,
): Promise<PersistedResultMetadata> {
  for await (const line of readResultLines(stream)) {
    if (line.kind === 'columns') return { columns: line.columns };
  }
  return { columns: [] };
}

/** gzip JSONL を CSV テキストチャンクへ変換する。 */
export async function* streamPersistedCsv(stream: Readable): AsyncGenerator<string> {
  let headerWritten = false;
  for await (const line of readResultLines(stream)) {
    if (line.kind === 'columns') {
      if (line.columns.length > 0)
        yield `${csvRecord(line.columns.map((column) => column.name))}\r\n`;
      headerWritten = true;
      continue;
    }
    if (!headerWritten) {
      headerWritten = true;
    }
    yield `${csvRecord(line.row)}\r\n`;
  }
}

/** gzip JSONL を serializer 非依存の結果イベントへ変換する。 */
export async function* streamPersistedResultEvents(
  stream: Readable,
): AsyncGenerator<QueryResultEvent> {
  let columnsWritten = false;
  for await (const line of readResultLines(stream)) {
    if (line.kind === 'columns') {
      columnsWritten = true;
      yield { type: 'columns', columns: line.columns };
      continue;
    }
    if (!columnsWritten) {
      columnsWritten = true;
      yield { type: 'columns', columns: [] };
    }
    yield { type: 'row', row: line.row };
  }
  if (!columnsWritten) yield { type: 'columns', columns: [] };
}

async function* readResultLines(stream: Readable): AsyncGenerator<ResultJsonlLine> {
  const gunzip = createGunzip();
  const lines = createInterface({
    input: stream.pipe(gunzip),
    crlfDelay: Infinity,
  });
  for await (const raw of lines) {
    if (raw.trim() === '') continue;
    yield parseLine(raw);
  }
}

function parseLine(line: string): ResultJsonlLine {
  const parsed = JSON.parse(line) as ResultJsonlLine;
  if (parsed.kind === 'columns') return { kind: 'columns', columns: parsed.columns };
  if (parsed.kind === 'record' && Array.isArray(parsed.row)) {
    return { kind: 'record', row: parsed.row };
  }
  throw new Error('Invalid persisted result JSONL line');
}
