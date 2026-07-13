/**
 * DuckDB の server-side Parquet 読み出しと HTTP Range の成立条件を測る bounded PoC。
 * httpfs の cold install は外部 network に依存するため、通常 test から分離し、
 * `test:duckdb-poc` で明示実行する。`@duckdb/node-api` は devDependency なので、通常 CI の
 * dependency install にも native binding の install cost（linux-x64 展開後約70 MB）が乗る。
 * 通常 CI で除外されるのは PoC test 本体と httpfs cold install の network cost であり、Range と pushdown の回帰検知は明示実行時だけ行う。本番 route と S3 credential は検証しない。
 */
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { afterAll, describe, expect, it } from 'vitest';

interface RangeRequestLog {
  method: string | undefined;
  range: string | undefined;
  status: number;
  contentRange?: string;
  bodyBytes: number;
}

interface RangeServer {
  url: string;
  requests: RangeRequestLog[];
  close(): Promise<void>;
}

interface QueryMeasurement {
  rows: unknown[][];
  requestCount: number;
  rangeGets: number;
  rangeLessGets: number;
  transferBytes: number;
  elapsedMs: number;
}

const fixtureDirectories: string[] = [];

afterAll(() => {
  for (const directory of fixtureDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function installHttpfs(connection: DuckDBConnection): Promise<void> {
  await connection.run('INSTALL httpfs');
  await connection.run('LOAD httpfs');
}

async function prepareHttpfsExtension(): Promise<void> {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  try {
    // local Parquet の生成には不要だが、後続の fresh instance が LOAD できるよう先に install する。
    await installHttpfs(connection);
  } finally {
    connection.disconnectSync();
    instance.closeSync();
  }
}

async function createParquetFixture(path: string): Promise<unknown[][]> {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  try {
    await connection.run(`
      COPY (
        SELECT
          range::BIGINT AS id,
          CASE
            WHEN range % 17 = 0 THEN NULL
            ELSE 'n-' || CAST(range % 32 AS VARCHAR)
          END AS narrow_value,
          CASE
            WHEN range % 11 = 0 THEN NULL
            ELSE 'nullable-' || CAST(range AS VARCHAR)
          END AS nullable_value,
          md5(CAST(range AS VARCHAR) || '-0') ||
            md5(CAST(range AS VARCHAR) || '-1') ||
            md5(CAST(range AS VARCHAR) || '-2') ||
            md5(CAST(range AS VARCHAR) || '-3') ||
            md5(CAST(range AS VARCHAR) || '-4') ||
            md5(CAST(range AS VARCHAR) || '-5') ||
            md5(CAST(range AS VARCHAR) || '-6') ||
            md5(CAST(range AS VARCHAR) || '-7') AS wide_payload
        FROM range(60000)
      ) TO ${sqlString(path)}
      (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 10000)
    `);

    const metadata = await connection.runAndReadAll(
      `SELECT count(DISTINCT row_group_id) FROM parquet_metadata(${sqlString(path)})`,
    );
    const metadataRows = await metadata.getRowsJson();
    expect(Number(metadataRows[0]?.[0])).toBeGreaterThan(1);

    const expected = await connection.runAndReadAll(
      `SELECT * FROM read_parquet(${sqlString(path)}) ORDER BY id`,
    );
    return await expected.getRowsJson();
  } finally {
    connection.disconnectSync();
    instance.closeSync();
  }
}

async function createRangeServer(path: string): Promise<RangeServer> {
  const bytes = readFileSync(path);
  const requests: RangeRequestLog[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const log: RangeRequestLog = {
      method: request.method,
      range: request.headers.range,
      status: 0,
      bodyBytes: 0,
    };
    requests.push(log);

    if (url.pathname !== '/fixture.parquet') {
      log.status = 404;
      response.writeHead(404, { 'Content-Length': 0 });
      response.end();
      return;
    }
    if (request.method === 'HEAD') {
      log.status = 200;
      response.writeHead(200, {
        'Accept-Ranges': 'bytes',
        'Content-Length': bytes.length,
      });
      response.end();
      return;
    }
    if (request.method !== 'GET') {
      log.status = 405;
      response.writeHead(405, { 'Content-Length': 0 });
      response.end();
      return;
    }

    const match = /^bytes=(\d+)-(\d+)?$/.exec(request.headers.range ?? '');
    if (match === null) {
      log.status = 416;
      response.writeHead(416, { 'Content-Length': 0 });
      response.end();
      return;
    }
    const start = Number(match[1]);
    const end = match[2] === undefined ? bytes.length - 1 : Number(match[2]);
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      end >= bytes.length
    ) {
      log.status = 416;
      response.writeHead(416, { 'Content-Length': 0 });
      response.end();
      return;
    }

    const body = bytes.subarray(start, end + 1);
    log.status = 206;
    log.contentRange = `bytes ${start}-${end}/${bytes.length}`;
    log.bodyBytes = body.length;
    response.writeHead(206, {
      'Accept-Ranges': 'bytes',
      'Content-Length': body.length,
      'Content-Range': log.contentRange,
      'Content-Type': 'application/octet-stream',
    });
    response.end(body);
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('HTTP Range server did not expose a TCP address');
  }

  return {
    url: `http://127.0.0.1:${address.port}/fixture.parquet`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

async function runRemoteQuery(
  server: RangeServer,
  name: string,
  sql: string,
): Promise<QueryMeasurement> {
  const requestStart = server.requests.length;
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  const startedAt = performance.now();
  try {
    await connection.run('LOAD httpfs');
    await connection.run('SET enable_external_file_cache = false');
    await connection.run('SET enable_http_metadata_cache = false');
    await connection.run('SET enable_object_cache = false');
    const reader = await connection.runAndReadAll(
      sql.replace('$URL', `${server.url}?case=${encodeURIComponent(name)}`),
    );
    const rows = await reader.getRowsJson();
    const requestSlice = server.requests.slice(requestStart);
    return {
      rows,
      requestCount: requestSlice.length,
      rangeGets: requestSlice.filter((request) => request.method === 'GET' && request.range).length,
      rangeLessGets: requestSlice.filter(
        (request) => request.method === 'GET' && request.range === undefined,
      ).length,
      transferBytes: requestSlice
        .filter((request) => request.method === 'GET')
        .reduce((total, request) => total + request.bodyBytes, 0),
      elapsedMs: performance.now() - startedAt,
    };
  } finally {
    connection.disconnectSync();
    instance.closeSync();
  }
}

async function runWithAbort(
  connection: DuckDBConnection,
  sql: string,
  signal: AbortSignal,
): Promise<unknown> {
  const interrupt = () => connection.interrupt();
  signal.addEventListener('abort', interrupt, { once: true });
  try {
    return await connection.run(sql);
  } finally {
    signal.removeEventListener('abort', interrupt);
  }
}

describe('DuckDB Parquet Range PoC', () => {
  it('compares baseline, projection, and filter pushdown over HTTP Range', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hubble-duckdb-poc-'));
    fixtureDirectories.push(directory);
    const fixturePath = join(directory, 'fixture.parquet');
    await prepareHttpfsExtension();
    const expectedRows = await createParquetFixture(fixturePath);
    const server = await createRangeServer(fixturePath);
    try {
      const baseline = await runRemoteQuery(
        server,
        'baseline',
        `SELECT * FROM read_parquet('$URL') ORDER BY id`,
      );
      const projection = await runRemoteQuery(
        server,
        'projection',
        `SELECT id, narrow_value FROM read_parquet('$URL') ORDER BY id`,
      );
      const filtered = await runRemoteQuery(
        server,
        'filtered',
        `SELECT id, narrow_value FROM read_parquet('$URL') WHERE id BETWEEN 1000 AND 1999 ORDER BY id`,
      );

      expect(baseline.rows).toEqual(expectedRows);
      expect(projection.rows).toEqual(expectedRows.map((row) => [row[0], row[1]]));
      expect(filtered.rows).toEqual(
        expectedRows
          .filter((row) => Number(row[0]) >= 1000 && Number(row[0]) <= 1999)
          .map((row) => [row[0], row[1]]),
      );

      const measurements = [baseline, projection, filtered];
      expect(measurements.every((measurement) => measurement.rangeGets > 0)).toBe(true);
      expect(measurements.every((measurement) => measurement.rangeLessGets === 0)).toBe(true);
      expect(projection.transferBytes * 2).toBeLessThan(baseline.transferBytes);
      expect(filtered.transferBytes * 2).toBeLessThan(projection.transferBytes);

      const fileSize = statSync(fixturePath).size;
      for (const request of server.requests) {
        if (request.method === 'HEAD') {
          expect(request.status).toBe(200);
          expect(request.bodyBytes).toBe(0);
        }
        if (request.method === 'GET') {
          expect(request.status).toBe(206);
          expect(request.range).toMatch(/^bytes=\d+-\d+$/);
          expect(request.contentRange).toMatch(/^bytes \d+-\d+\/\d+$/);
          expect(request.bodyBytes).toBeGreaterThan(0);
        }
      }
      console.info('DuckDB/Parquet PoC metrics', {
        duckdb: '1.5.4-r.1',
        extension: 'httpfs installed from DuckDB extension repository, then loaded',
        fileSize,
        requests: server.requests.length,
        baseline,
        projection,
        filtered,
      });
    } finally {
      await server.close();
    }
  });

  it('connects AbortSignal to DuckDBConnection.interrupt', async () => {
    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();
    const controller = new AbortController();
    try {
      // 即時 abort は API 接続の PoC であり、本番では query lifecycle と interrupt 所有権を設計する。
      const query = runWithAbort(
        connection,
        'SELECT sum(range) FROM range(1000000000000)',
        controller.signal,
      );
      controller.abort();
      await expect(query).rejects.toThrow(/Interrupted/);
    } finally {
      connection.disconnectSync();
      instance.closeSync();
    }
  });
});
