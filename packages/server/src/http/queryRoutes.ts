import { Readable } from 'node:stream';
import { ZipFile } from 'yazl';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { stream } from 'hono/streaming';
import type { StreamingApi } from 'hono/utils/stream';
import {
  createQueryRequestSchema,
  estimateRequestSchema,
  type QueryRowsPage,
} from '@hubble/contracts';
import type { Services } from '../services';
import type { TrinoRequestContext } from '../trino/types';
import type { OverflowMode } from '../query/execution';
import type { AuthVariables } from '../auth/middleware';
import { AppError } from '../errors';
import { disabledEstimate, guardLimitsSnapshot } from '../query/guard';
import { intParam, parseJsonBody } from './validate';
import { buildReplayEvents, encodeSseEvent, SSE_KEEPALIVE } from '../query/sse';
import { streamQueryCsv } from '../query/csv';

const KEEPALIVE_INTERVAL_MS = 15_000;

/**
 * Query endpoints (design.md §7): submit/snapshot/events(SSE)/rows/cancel/CSV.
 * Mounted under `/api/queries`.
 */
export function queryRoutes(services: Services): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();

  // POST /api/queries/estimate — Query Guard scan-cost estimate (no execution).
  app.post('/estimate', async (c) => {
    const body = await parseJsonBody(c, estimateRequestSchema);
    // mode=off: never touch Trino; return a `disabled` estimate immediately.
    if (services.config.guard.mode === 'off') {
      return c.json(disabledEstimate());
    }
    const principal = c.var.principal;
    const result = await services.estimate.estimate({
      statement: body.statement,
      catalog: body.catalog ?? services.config.defaults.catalog,
      schema: body.schema ?? services.config.defaults.schema,
      principal: principal.user,
    });
    return c.json(result);
  });

  // POST /api/queries — accept and start; respond 202 with the queryId.
  app.post('/', async (c) => {
    const body = await parseJsonBody(c, createQueryRequestSchema);
    const principal = c.var.principal;
    const catalog = body.catalog ?? services.config.defaults.catalog;
    const schema = body.schema ?? services.config.defaults.schema;
    const ctx: TrinoRequestContext = {
      catalog,
      schema,
      source: body.source,
      // Impersonate the authenticated principal for this user query (design.md §11).
      user: principal.user,
      sessionProperties: body.sessionProperties,
    };

    // Query Guard enforce: estimate (reusing a fresh cached estimate from a
    // just-prior /estimate call so this is usually a no-op) and block before
    // any execution when the verdict says so.
    if (services.config.guard.mode === 'enforce') {
      const estimate = await services.estimate.estimate({
        statement: body.statement,
        catalog,
        schema,
        principal: principal.user,
      });
      if (estimate.verdict.decision === 'block') {
        throw AppError.queryBlocked(estimate.verdict.reasons[0] ?? 'Query blocked by Query Guard', {
          estimate,
          limits: guardLimitsSnapshot(services.config),
        });
      }
    }

    const overflowMode: OverflowMode | undefined =
      body.maxRows !== undefined ? services.config.query.overflowMode : undefined;
    const exec = services.queries.submit({
      statement: body.statement,
      ctx,
      owner: principal.user,
      maxRows: body.maxRows,
      overflowMode,
      notebookId: body.notebookId,
      cellId: body.cellId,
    });
    return c.json({ queryId: exec.queryId }, 202);
  });

  /**
   * Fetch an execution scoped to the requesting principal. A query is owned by
   * the principal whose impersonation user started it (design.md §11); another
   * user gets a 404 (indistinguishable from "unknown id"), so executions never
   * leak across owners.
   */
  const ownedExec = (c: { req: { param: (k: string) => string }; var: AuthVariables }) => {
    const exec = services.registry.getOrThrow(c.req.param('id'));
    if (exec.ctx.user !== undefined && exec.ctx.user !== c.var.principal.user) {
      throw AppError.notFound(`Query ${c.req.param('id')} not found`);
    }
    return exec;
  };

  // GET /api/queries/:id — snapshot.
  app.get('/:id', (c) => {
    const exec = ownedExec(c);
    return c.json(exec.snapshot());
  });

  // GET /api/queries/:id/rows?offset&limit — page of buffered rows.
  app.get('/:id/rows', (c) => {
    const exec = ownedExec(c);
    const offset = intParam(c.req.query('offset'), 0);
    const limit = Math.min(Math.max(intParam(c.req.query('limit'), 100), 1), 10_000);
    const page: QueryRowsPage = {
      offset,
      rows: exec.getRows(offset, limit),
      totalBuffered: exec.bufferedCount,
      complete: exec.isTerminal,
    };
    return c.json(page);
  });

  // DELETE /api/queries/:id — cancel.
  app.delete('/:id', async (c) => {
    const exec = ownedExec(c);
    await exec.requestCancel();
    return c.json(exec.snapshot());
  });

  // GET /api/queries/:id/events — SSE replay + live.
  app.get('/:id/events', (c) => {
    const exec = ownedExec(c);
    return streamSSE(c, async (sseStream) => {
      // Buffer live events that arrive during replay, then flush in order.
      const pending: string[] = [];
      let replaying = true;
      const unsubscribe = exec.subscribe((event) => {
        const frame = encodeSseEvent(event);
        if (replaying) {
          pending.push(frame);
        } else {
          void sseStream.write(frame);
        }
      });

      const done = new Promise<void>((resolve) => {
        if (exec.isTerminal) resolve();
        else void exec.settled.then(resolve);
      });

      const keepAlive = setInterval(() => {
        void sseStream.write(SSE_KEEPALIVE);
      }, KEEPALIVE_INTERVAL_MS);

      sseStream.onAbort(() => {
        clearInterval(keepAlive);
        unsubscribe();
      });

      try {
        // Replay current state snapshot.
        for (const event of buildReplayEvents(exec)) {
          await sseStream.write(encodeSseEvent(event));
        }
        // Flush events that arrived during replay, then go live.
        replaying = false;
        for (const frame of pending) {
          await sseStream.write(frame);
        }
        pending.length = 0;

        // Wait for the query to settle (live events flow via the subscriber).
        await done;
      } finally {
        clearInterval(keepAlive);
        unsubscribe();
      }
    });
  });

  // GET /api/queries/:id/download.csv?compression=gzip|zip
  app.get('/:id/download.csv', (c) => {
    const exec = ownedExec(c);
    const compression = c.req.query('compression');
    const gzip = compression === 'gzip';
    const zip = compression === 'zip';
    const csvName = `${exec.queryId}.csv`;
    const filename = zip ? `${exec.queryId}.zip` : `${csvName}${gzip ? '.gz' : ''}`;

    c.header('Content-Type', zip ? 'application/zip' : 'text/csv; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename="${filename}"`);
    if (gzip) c.header('Content-Encoding', 'gzip');
    c.header('Cache-Control', 'no-store');

    return stream(c, async (rawStream) => {
      // Abort signal drives both the response and the (possible) Trino re-run,
      // so a client disconnect tears the download query down.
      const ac = new AbortController();
      rawStream.onAbort(() => ac.abort());
      const csv = streamQueryCsv(exec, { client: services.trino, signal: ac.signal });

      if (zip) {
        await pipeZip(rawStream, csvName, csv, ac.signal);
      } else if (gzip) {
        // Pipe CSV text through a gzip CompressionStream.
        const gz = new CompressionStream('gzip');
        const writer = gz.writable.getWriter();
        const encoder = new TextEncoder();
        const pumped = rawStream.pipe(gz.readable);
        try {
          for await (const chunk of csv) {
            if (ac.signal.aborted) break;
            await writer.write(encoder.encode(chunk));
          }
        } finally {
          await writer.close();
          await pumped;
        }
      } else {
        for await (const chunk of csv) {
          if (ac.signal.aborted) break;
          await rawStream.write(chunk);
        }
      }
    });
  });

  return app;
}

/**
 * Stream a single-entry DEFLATE zip to the HTTP response. The CSV text generator
 * is fed into yazl as a Node Readable (constant memory: yazl deflates and emits
 * compressed chunks as input arrives); yazl's compressed output stream is pumped
 * to Hono's `StreamingApi`. The whole CSV is never held in memory.
 */
async function pipeZip(
  out: StreamingApi,
  entryName: string,
  csv: AsyncGenerator<string>,
  signal: AbortSignal,
): Promise<void> {
  const zip = new ZipFile();
  const source = Readable.from(csvBytes(csv, signal));
  // mtime fixed so output is deterministic; size unknown -> streaming entry.
  zip.addReadStream(source, entryName, { compress: true, mtime: new Date(0) });
  zip.end();

  try {
    for await (const chunk of zip.outputStream as AsyncIterable<Buffer>) {
      if (signal.aborted) break;
      await out.write(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    }
  } finally {
    // If we bailed early, drain the CSV generator's cleanup (Trino cancel).
    if (signal.aborted) {
      source.destroy();
      await csv.return(undefined).catch(() => {});
    }
  }
}

/** UTF-8 encode each CSV text chunk for yazl, stopping early on abort. */
async function* csvBytes(csv: AsyncGenerator<string>, signal: AbortSignal): AsyncGenerator<Buffer> {
  const encoder = new TextEncoder();
  for await (const chunk of csv) {
    if (signal.aborted) return;
    yield Buffer.from(encoder.encode(chunk));
  }
}

// Re-export so app.ts can register a not-found that throws AppError consistently.
export { AppError };
