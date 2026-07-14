/**
 * CSV、Hono、Node stream、ZIP の境界をまとめた export 用ストリーム部品。
 *
 * 行ソースの解決は query/resultEvents.ts、CSV の値整形は query/csv.ts が担当し、
 * このファイルは bytes 化、backpressure、圧縮、後始末だけを担当する。
 */
import { PassThrough, Readable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { ZipFile } from 'yazl';
import type { StreamingApi } from 'hono/utils/stream';
import { createSqlAbortError } from '../engine/sql/abort';
import { csvFromEvents } from '../query/csv';
import {
  openQueryResultEvents,
  type QueryResultEvent,
  type QueryResultEventInput,
} from '../query/resultEvents';

/** CSV テキストを UTF-8 バイトチャンクへ変換する。 */
export async function* csvBytes(
  csv: AsyncIterable<string>,
  signal?: AbortSignal,
): AsyncGenerator<Buffer> {
  const encoder = new TextEncoder();
  for await (const chunk of csv) {
    if (signal?.aborted) return;
    yield Buffer.from(encoder.encode(chunk));
  }
}

/** QueryResultEvent を PassThrough へ書き込み、S3 export などから再利用する。 */
export async function writeCsvEvents(
  events: AsyncGenerator<QueryResultEvent>,
  stream: PassThrough,
  options: { gzip: boolean; signal?: AbortSignal },
): Promise<void> {
  const source = Readable.from(csvFromEvents(events));
  try {
    if (options.gzip) {
      await pipeline(source, createGzip(), stream, { signal: options.signal });
    } else {
      await pipeline(source, stream, { signal: options.signal });
    }
  } catch (error) {
    if (options.signal?.aborted) throw createSqlAbortError();
    throw error;
  }
}

/** CSV を無圧縮、gzip、または決定的な単一エントリ ZIP として返す。 */
export async function pipeCsvDownload(
  out: StreamingApi,
  entryName: string,
  events: AsyncGenerator<QueryResultEvent>,
  options: { gzip: boolean; zip: boolean; signal: AbortSignal },
): Promise<void> {
  if (options.zip) {
    await pipeCsvEntriesZip(out, [{ entryName, events }], options.signal);
    return;
  }
  const csv = csvFromEvents(events);
  if (options.gzip) {
    await pipeGzip(out, csv, options.signal);
    return;
  }

  try {
    for await (const chunk of csv) {
      if (options.signal.aborted) break;
      await out.write(chunk);
      if (options.signal.aborted) break;
    }
  } finally {
    await events.return(undefined).catch(() => undefined);
  }
}

/** 複数の遅延 event input を 1 つの決定的な ZIP へ流す。 */
export async function pipeCsvEntriesZip(
  out: StreamingApi,
  entries: ReadonlyArray<{ entryName: string; events: QueryResultEventInput }>,
  signal: AbortSignal,
): Promise<void> {
  const zip = new ZipFile();
  const outputStream = zip.outputStream as unknown as Readable;
  const sources: Array<{
    source: Readable;
    csv: AsyncGenerator<string>;
    relayError: (error: unknown) => void;
  }> = [];
  let zipFailure: unknown;
  const onZipError = (error: unknown): void => {
    if (zipFailure !== undefined) return;
    zipFailure = error;
    const failure = error instanceof Error ? error : new Error(String(error));
    if (!outputStream.destroyed) outputStream.destroy(failure);
  };
  const onOutputError = (error: unknown): void => {
    zipFailure ??= error;
  };
  zip.on('error', onZipError);
  outputStream.on('error', onOutputError);
  try {
    for (const entry of entries) {
      const csv = csvFromEventInput(entry.events, signal);
      const source = Readable.from(csvBytes(csv, signal));
      const onSourceError = (error: unknown): void => {
        zip.emit('error', error instanceof Error ? error : new Error(String(error)));
      };
      source.once('error', onSourceError);
      sources.push({ source, csv, relayError: onSourceError });
      zip.addReadStream(source, entry.entryName, { compress: true, mtime: new Date(0) });
    }
    zip.end();
    for await (const chunk of outputStream as AsyncIterable<Buffer>) {
      if (signal.aborted) break;
      await out.write(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    }
    if (zipFailure !== undefined) {
      throw zipFailure instanceof Error ? zipFailure : new Error(String(zipFailure));
    }
  } finally {
    for (const { source, csv, relayError } of sources) {
      source.removeListener('error', relayError);
      const absorbCleanupError = (): void => undefined;
      source.on('error', absorbCleanupError);
      const sourceFinished = finished(source).catch(() => undefined);
      source.destroy();
      await sourceFinished;
      source.removeListener('error', absorbCleanupError);
      await csv.return(undefined).catch(() => undefined);
    }
    if (!outputStream.destroyed) outputStream.destroy();
    zip.removeListener('error', onZipError);
    outputStream.removeListener('error', onOutputError);
  }
}

/** Node Readable を Hono StreamingApi へ流し、中断やエラー時に source を破棄する。 */
export async function pipeNodeReadable(
  out: StreamingApi,
  source: Readable,
  signal: AbortSignal,
): Promise<void> {
  try {
    for await (const chunk of source) {
      if (signal.aborted) break;
      const buffer =
        chunk instanceof Uint8Array
          ? chunk
          : Buffer.from(typeof chunk === 'string' ? chunk : String(chunk));
      await out.write(buffer);
    }
  } finally {
    source.destroy();
  }
}

async function* csvFromEventInput(
  input: QueryResultEventInput,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const events = await openQueryResultEvents(input, signal);
  yield* csvFromEvents(events);
}

async function pipeGzip(
  out: StreamingApi,
  csv: AsyncGenerator<string>,
  signal: AbortSignal,
): Promise<void> {
  const gzip = new CompressionStream('gzip');
  const writer = gzip.writable.getWriter();
  const pumped = out.pipe(gzip.readable);
  const encoder = new TextEncoder();
  try {
    for await (const chunk of csv) {
      if (signal.aborted) break;
      await writer.write(encoder.encode(chunk));
    }
  } finally {
    try {
      await writer.close().catch(() => undefined);
      await pumped;
    } finally {
      await csv.return(undefined).catch(() => undefined);
    }
  }
}
