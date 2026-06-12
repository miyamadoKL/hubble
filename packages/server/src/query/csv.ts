import type { TrinoClient } from '../trino/client';
import {
  emptySessionMutations,
  type TrinoColumn,
  type TrinoRequestContext,
} from '../trino/types';
import type { QueryExecution } from './execution';

/** `X-Trino-Source` used by CSV re-execution queries (kept out of history). */
export const DOWNLOAD_SOURCE = 'hubble-download';

/** RFC 4180 field quoting: quote if the value contains `,` `"` CR or LF. */
export function csvField(value: unknown): string {
  const s = formatCell(value);
  if (s === '') return s;
  if (/[",\r\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/** Render a single cell value to its CSV text form. */
export function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  // Arrays / objects (Trino MAP/ARRAY/ROW/JSON) -> compact JSON.
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Build one CSV record line (no trailing newline) from a row. */
export function csvRecord(row: readonly unknown[]): string {
  return row.map(csvField).join(',');
}

/**
 * Stream a query's buffered rows as RFC 4180 CSV. If the query is still
 * running, this follows the buffer as it grows and waits for completion.
 *
 * UTF-8, no BOM, CRLF line terminators (RFC 4180). `\r\n` after every record
 * including the header. `flushEvery` rows we yield control to let the runtime
 * flush the underlying response stream.
 */
export async function* streamCsv(
  exec: QueryExecution,
  opts: { flushEvery?: number } = {},
): AsyncGenerator<string> {
  const flushEvery = opts.flushEvery ?? 500;

  // Header is available as soon as columns are known; wait if necessary.
  await waitForColumnsOrTerminal(exec);
  if (exec.columns.length > 0) {
    yield csvRecord(exec.columns.map((c) => c.name)) + '\r\n';
  }

  let index = 0;
  let sinceFlush = 0;
  let chunk = '';
  // Drain buffered rows, following the buffer until the query is terminal AND
  // we've emitted every buffered row.
  for (;;) {
    const row = exec.rowAt(index);
    if (row !== undefined) {
      chunk += csvRecord(row) + '\r\n';
      index += 1;
      sinceFlush += 1;
      if (sinceFlush >= flushEvery) {
        yield chunk;
        chunk = '';
        sinceFlush = 0;
      }
      continue;
    }
    // No more buffered rows at this index.
    if (exec.isTerminal && index >= exec.bufferedCount) {
      break;
    }
    // Query still running and no row yet at this index: flush and wait a tick.
    if (chunk !== '') {
      yield chunk;
      chunk = '';
      sinceFlush = 0;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  if (chunk !== '') yield chunk;
}

export interface CsvDownloadDeps {
  /** Client used to issue the dedicated re-execution query (source hubble-download). */
  client: TrinoClient;
  /** Aborts the re-execution fetch when the HTTP client disconnects. */
  signal?: AbortSignal;
}

/**
 * Stream a query's full result as CSV.
 *
 * - When the execution is terminal and complete (`!truncated`), the buffered
 *   page store holds every row, so we replay it for free (no Trino round-trip).
 * - Otherwise (still running, or capped at maxRows) the page store is an
 *   incomplete preview. We re-run the exact statement in a fresh Trino query —
 *   same user/catalog/schema/session — and stream every received page straight
 *   to CSV with no row cap and constant memory (no page store). The re-run uses
 *   source `hubble-download` and is never recorded in query history.
 *
 * Abort (HTTP client disconnect) cancels the re-execution query via DELETE.
 */
export function streamQueryCsv(
  exec: QueryExecution,
  deps: CsvDownloadDeps,
  opts: { flushEvery?: number } = {},
): AsyncGenerator<string> {
  if (exec.isTerminal && !exec.truncated) {
    return streamCsv(exec, opts);
  }
  return streamCsvReexec(exec, deps, opts);
}

/**
 * Re-execute `exec.statement` against Trino and stream every row as CSV with no
 * row cap, applying the C-1 backoff discipline (zero delay while data flows).
 */
export async function* streamCsvReexec(
  exec: QueryExecution,
  deps: CsvDownloadDeps,
  opts: { flushEvery?: number } = {},
): AsyncGenerator<string> {
  const flushEvery = opts.flushEvery ?? 500;
  const { client, signal } = deps;
  // Inherit the original execution context but force the download source so the
  // re-run is attributable and excluded from history.
  const ctx: TrinoRequestContext = { ...exec.ctx, source: DOWNLOAD_SOURCE };
  const mutations = emptySessionMutations();

  let currentNextUri: string | undefined;
  let headerWritten = false;
  let chunk = '';
  let sinceFlush = 0;

  const writeHeader = (columns: TrinoColumn[] | undefined): void => {
    if (headerWritten || !columns || columns.length === 0) return;
    headerWritten = true;
    chunk += csvRecord(columns.map((col) => col.name)) + '\r\n';
  };

  try {
    let page = await client.start(exec.statement, ctx, mutations, signal);
    writeHeader(page.columns);
    if (page.data) {
      for (const row of page.data) {
        chunk += csvRecord(row) + '\r\n';
        sinceFlush += 1;
      }
    }

    let idleAttempt = 0;
    while (page.nextUri) {
      currentNextUri = page.nextUri;
      if (signal?.aborted) break;
      const hadData = page.data !== undefined && page.data.length > 0;
      if (hadData) {
        idleAttempt = 0;
      } else {
        await client.waitBackoff(idleAttempt, signal);
        idleAttempt += 1;
      }
      if (signal?.aborted) break;
      page = await client.advance(page.nextUri, ctx, mutations, signal);
      writeHeader(page.columns);
      if (page.data) {
        for (const row of page.data) {
          chunk += csvRecord(row) + '\r\n';
          sinceFlush += 1;
        }
      }
      if (sinceFlush >= flushEvery) {
        yield chunk;
        chunk = '';
        sinceFlush = 0;
      }
    }
    // Reached here without a nextUri => the query finished; no teardown needed.
    if (!page.nextUri) currentNextUri = undefined;
    if (!signal?.aborted && chunk !== '') yield chunk;
  } finally {
    // If we left the loop early (client disconnect or an error) the query may
    // still be running server-side; DELETE its current nextUri to tear it down.
    if (currentNextUri) {
      await client.cancel(currentNextUri, ctx).catch(() => {});
    }
  }
}

function waitForColumnsOrTerminal(exec: QueryExecution): Promise<void> {
  if (exec.columns.length > 0 || exec.isTerminal) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = exec.subscribe((event) => {
      if (event.type === 'columns' || event.type === 'done') {
        unsubscribe();
        resolve();
      }
    });
    // Guard against a race where it became terminal between the check and subscribe.
    if (exec.columns.length > 0 || exec.isTerminal) {
      unsubscribe();
      resolve();
    }
  });
}
