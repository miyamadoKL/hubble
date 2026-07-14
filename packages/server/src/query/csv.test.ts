import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { CSV_REEXEC_UNAVAILABLE } from '@hubble/contracts';
import type { ApiError } from '@hubble/contracts';
import { CSV_REEXEC_HEADER, CSV_TRUNCATED_HEADER, csvField, csvRecord } from './csv';
import { streamQueryResultEvents } from './resultEvents';
import { createTestContext } from '../test/harness';
import type { FakeScenario } from '../test/fakeTrino';

describe('csvField (RFC 4180 quoting)', () => {
  it('leaves simple values unquoted', () => {
    expect(csvField('abc')).toBe('abc');
    expect(csvField(42)).toBe('42');
    expect(csvField(true)).toBe('true');
  });
  it.each([
    ['=1+1', "'=1+1"],
    ['+cmd', "'+cmd"],
    ['-1', "'-1"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['\tvalue', "'\tvalue"],
    ['\rvalue', '"\'\rvalue"'],
    ['\nvalue', '"\'\nvalue"'],
  ])('neutralizes formula-leading string %j', (value, expected) => {
    expect(csvField(value)).toBe(expected);
  });
  it('neutralizes before applying RFC 4180 quoting', () => {
    expect(csvField('=SUM(A1,B1)')).toBe('"\'=SUM(A1,B1)"');
  });
  it('keeps signed numbers numeric', () => {
    expect(csvField(-1)).toBe('-1');
    expect(csvField(1)).toBe('1');
  });
  it('renders null/undefined as empty', () => {
    expect(csvField(null)).toBe('');
    expect(csvField(undefined)).toBe('');
  });
  it('quotes and escapes values with comma, quote, or newline', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('he said "hi"')).toBe('"he said ""hi"""');
    expect(csvField('line1\nline2')).toBe('"line1\nline2"');
  });
  it('serializes objects/arrays as JSON', () => {
    expect(csvField({ a: 1 })).toBe('"{""a"":1}"');
    expect(csvField([1, 2])).toBe('"[1,2]"');
    expect(csvField({ formula: '=1+1' })).toBe('"{""formula"":""=1+1""}"');
    expect(csvField(['@SUM(A1)'])).toBe('"[""@SUM(A1)""]"');
  });
  it('checks fallback text produced from objects and arrays', () => {
    const objectValue: { self?: unknown; toString: () => string } = {
      toString: () => '=object',
    };
    objectValue.self = objectValue;

    const arrayValue: unknown[] & { toString: () => string } = [];
    arrayValue.push(arrayValue);
    arrayValue.toString = () => '@array';

    expect(csvField(objectValue)).toBe("'=object");
    expect(csvField(arrayValue)).toBe("'@array");
  });
  it('builds a full record', () => {
    expect(csvRecord(['a', 'b,c', 1])).toBe('a,"b,c",1');
  });
});

const COLUMNS = [
  { name: 'id', type: 'bigint' },
  { name: 'note', type: 'varchar' },
];

function csvScenario(): FakeScenario {
  return {
    match: 'csv',
    trinoId: 'csv',
    pages: [
      {
        columns: COLUMNS,
        data: [
          [1, 'plain'],
          [2, 'has,comma'],
          [3, 'has "quote"'],
        ],
        state: 'FINISHED',
      },
    ],
  };
}

describe('CSV download endpoint', () => {
  it('streams header + RFC4180-quoted rows, no BOM', async () => {
    const ctx = await createTestContext({ scenarios: [csvScenario()] });
    const res = await ctx.app.request('/api/queries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ statement: 'SELECT * FROM csv' }),
    });
    const { queryId } = (await res.json()) as { queryId: string };
    await ctx.services.registry.get(queryId)!.settled;

    const csvRes = await ctx.app.request(`/api/queries/${queryId}/download.csv`);
    expect(csvRes.status).toBe(200);
    expect(csvRes.headers.get('content-type')).toContain('text/csv');
    expect(csvRes.headers.get('content-disposition')).toContain('attachment');
    const auditRows = await ctx.services.audit.listForTest();
    expect(auditRows.some((row) => row.action === 'csv.download' && row.target === queryId)).toBe(
      true,
    );
    expect(auditRows.find((row) => row.action === 'csv.download')?.detail).toMatchObject({
      compression: 'none',
      needsReexec: false,
      allowsReexec: true,
    });
    const body = await csvRes.text();
    expect(body.charCodeAt(0)).not.toBe(0xfeff); // no BOM
    const lines = body.split('\r\n').filter((l) => l !== '');
    expect(lines[0]).toBe('id,note');
    expect(lines[1]).toBe('1,plain');
    expect(lines[2]).toBe('2,"has,comma"');
    expect(lines[3]).toBe('3,"has ""quote"""');
  });

  it('gzip-compresses when compression=gzip', async () => {
    const ctx = await createTestContext({ scenarios: [csvScenario()] });
    const res = await ctx.app.request('/api/queries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ statement: 'SELECT * FROM csv' }),
    });
    const { queryId } = (await res.json()) as { queryId: string };
    await ctx.services.registry.get(queryId)!.settled;

    const csvRes = await ctx.app.request(`/api/queries/${queryId}/download.csv?compression=gzip`);
    expect(csvRes.headers.get('content-encoding')).toBe('gzip');
    expect(csvRes.headers.get('content-disposition')).toContain('.csv.gz');
    const buf = Buffer.from(await csvRes.arrayBuffer());
    const text = gunzipSync(buf).toString('utf8');
    expect(text.split('\r\n')[0]).toBe('id,note');
    expect(text).toContain('"has,comma"');
  });

  it('zips a single .csv entry when compression=zip', async () => {
    const ctx = await createTestContext({ scenarios: [csvScenario()] });
    const res = await ctx.app.request('/api/queries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ statement: 'SELECT * FROM csv' }),
    });
    const { queryId } = (await res.json()) as { queryId: string };
    await ctx.services.registry.get(queryId)!.settled;

    const zipRes = await ctx.app.request(`/api/queries/${queryId}/download.csv?compression=zip`);
    expect(zipRes.headers.get('content-type')).toBe('application/zip');
    expect(zipRes.headers.get('content-disposition')).toContain(`${queryId}.zip`);
    const buf = Buffer.from(await zipRes.arrayBuffer());
    const entries = await unzip(buf);
    const names = Object.keys(entries);
    expect(names).toEqual([`${queryId}.csv`]);
    const text = entries[`${queryId}.csv`]!.toString('utf8');
    expect(text.split('\r\n')[0]).toBe('id,note');
    expect(text).toContain('2,"has,comma"');
  });
});

/** Many-row scenario: one row per page, so a small maxRows truncates the buffer. */
function manyRowScenario(rowCount: number): FakeScenario {
  const pages = Array.from({ length: rowCount }, (_, i) => ({
    columns: i === 0 ? COLUMNS : undefined,
    data: [[i, `note_${i}`]],
    state: i === rowCount - 1 ? 'FINISHED' : 'RUNNING',
  }));
  return { match: 'many', trinoId: 'many', pages };
}

describe('CSV full-result re-execution (C-2)', () => {
  it('emits all rows for a truncated execution (not just the buffered preview)', async () => {
    // Buffer is capped at 5 rows, but the full result is 20 rows. The CSV must
    // re-run the statement and stream all 20.
    const ctx = await createTestContext({
      scenarios: [manyRowScenario(20)],
      configOverrides: { query: { maxRows: 5 } as never },
    });
    const res = await ctx.app.request('/api/queries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ statement: 'SELECT * FROM many', maxRows: 5 }),
    });
    const { queryId } = (await res.json()) as { queryId: string };
    const exec = ctx.services.registry.get(queryId)!;
    await exec.settled;
    expect(exec.truncated).toBe(true);
    expect(exec.bufferedCount).toBe(5);

    const historyBefore = (
      await ctx.services.history.list(ctx.services.config.trino.user, { limit: 500 })
    ).total;

    const csvRes = await ctx.app.request(`/api/queries/${queryId}/download.csv`);
    const body = await csvRes.text();
    const lines = body.split('\r\n').filter((l) => l !== '');
    expect(lines[0]).toBe('id,note');
    expect(lines).toHaveLength(21); // header + 20 rows
    expect(lines[1]).toBe('0,note_0');
    expect(lines[20]).toBe('19,note_19');

    // The re-execution must use the download source and not touch history.
    const reexecPost = ctx.fake.requests.find(
      (r) => r.method === 'POST' && r.headers['x-trino-source'] === 'hubble-download',
    );
    expect(reexecPost).toBeDefined();
    expect(
      (await ctx.services.history.list(ctx.services.config.trino.user, { limit: 500 })).total,
    ).toBe(historyBefore);
  });

  it('cancels the re-execution query (DELETE) when the stream is aborted', async () => {
    const ctx = await createTestContext({
      scenarios: [manyRowScenario(50)],
      configOverrides: { query: { maxRows: 2 } as never },
    });
    const res = await ctx.app.request('/api/queries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ statement: 'SELECT * FROM many', maxRows: 2 }),
    });
    const { queryId } = (await res.json()) as { queryId: string };
    const exec = ctx.services.registry.get(queryId)!;
    await exec.settled;
    expect(exec.truncated).toBe(true);

    // Hono のインプロセスリクエストでは実クライアントの切断を再現しにくいため、
    // 再実行イベントを直接進めて途中で中断し、後始末の DELETE を確認する。
    const ac = new AbortController();
    const gen = streamQueryResultEvents(exec, { signal: ac.signal }).events;
    // 列と最初の行を取得した時点で live nextUri の応答待ちにし、中断して
    // finally の DELETE を発火させる。
    await gen.next();
    await gen.next();
    ac.abort();
    await gen.return(undefined);

    const deletes = ctx.fake.requests.filter((r) => r.method === 'DELETE');
    expect(deletes.length).toBeGreaterThanOrEqual(1);
  });

  it('does not re-exec side-effect statements when truncated (buffered rows only)', async () => {
    const ctx = await createTestContext({
      scenarios: [manyRowScenario(12)],
      configOverrides: { query: { maxRows: 3 } as never },
    });
    const res = await ctx.app.request('/api/queries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        statement: 'INSERT INTO t SELECT * FROM many',
        maxRows: 3,
      }),
    });
    const { queryId } = (await res.json()) as { queryId: string };
    const exec = ctx.services.registry.get(queryId)!;
    await exec.settled;
    expect(exec.truncated).toBe(true);

    const postsBefore = ctx.fake.requests.filter((r) => r.method === 'POST').length;
    const csvRes = await ctx.app.request(`/api/queries/${queryId}/download.csv`);
    expect(csvRes.status).toBe(200);
    expect(csvRes.headers.get(CSV_REEXEC_HEADER)).toBe('unavailable');
    expect(csvRes.headers.get(CSV_TRUNCATED_HEADER)).toBe('true');
    const body = await csvRes.text();
    const lines = body.split('\r\n').filter((l) => l !== '');
    expect(lines).toHaveLength(4); // header + 3 buffered rows
    const postsAfter = ctx.fake.requests.filter((r) => r.method === 'POST').length;
    expect(postsAfter).toBe(postsBefore);
  });
});

let reloadTempDir: string | undefined;

afterEach(() => {
  if (reloadTempDir) {
    rmSync(reloadTempDir, { recursive: true, force: true });
    reloadTempDir = undefined;
  }
});

describe('CSV re-exec engine pinning', () => {
  it('uses the pinned engine after datasource id is removed from the registry', async () => {
    reloadTempDir = mkdtempSync(join(tmpdir(), 'hubble-csv-reload-'));
    writeFileSync(
      join(reloadTempDir, 'datasources.yaml'),
      `datasources:
  - id: trino-a
    type: trino
    username: admin
    baseUrl: http://trino.test
`,
      'utf8',
    );
    const ctx = await createTestContext({
      env: { DATASOURCES_PATH: 'datasources.yaml' },
      cwd: reloadTempDir,
      scenarios: [manyRowScenario(15)],
      configOverrides: { query: { maxRows: 4 } as never },
    });
    const res = await ctx.app.request('/api/queries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        statement: 'SELECT * FROM many',
        datasourceId: 'trino-a',
        maxRows: 4,
      }),
    });
    const { queryId } = (await res.json()) as { queryId: string };
    const exec = ctx.services.registry.get(queryId)!;
    await exec.settled;
    expect(exec.truncated).toBe(true);
    const pinnedEngine = exec.engine;

    writeFileSync(
      join(reloadTempDir, 'datasources.yaml'),
      `datasources:
  - id: trino-a
    type: trino
    username: admin
    baseUrl: http://trino.test
  - id: trino-b
    type: trino
    username: admin
    baseUrl: http://trino.test
`,
      'utf8',
    );
    await ctx.services.reloadDatasources();
    expect(ctx.services.engines.has('trino-a')).toBe(true);
    expect(ctx.services.defaultDatasourceId).toBe('trino-a');

    const postsBefore = ctx.fake.requests.filter((r) => r.method === 'POST').length;
    const csvRes = await ctx.app.request(`/api/queries/${queryId}/download.csv`);
    expect(csvRes.status).toBe(200);
    const lines = (await csvRes.text()).split('\r\n').filter((l) => l !== '');
    expect(lines).toHaveLength(16);
    const reexecPost = ctx.fake.requests
      .slice(postsBefore)
      .find((r) => r.method === 'POST' && r.headers['x-trino-source'] === 'hubble-download');
    expect(reexecPost).toBeDefined();
    expect(pinnedEngine.isClosed()).toBe(false);
    await ctx.services.shutdown();
  });

  it('returns CSV_REEXEC_UNAVAILABLE when the pinned engine was closed by reload', async () => {
    reloadTempDir = mkdtempSync(join(tmpdir(), 'hubble-csv-reload-'));
    writeFileSync(
      join(reloadTempDir, 'datasources.yaml'),
      `datasources:
  - id: trino-a
    type: trino
    username: admin
    baseUrl: http://trino.test
`,
      'utf8',
    );
    const ctx = await createTestContext({
      env: { DATASOURCES_PATH: 'datasources.yaml' },
      cwd: reloadTempDir,
      scenarios: [manyRowScenario(10)],
      configOverrides: { query: { maxRows: 2 } as never },
    });
    const res = await ctx.app.request('/api/queries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        statement: 'SELECT * FROM many',
        datasourceId: 'trino-a',
        maxRows: 2,
      }),
    });
    const { queryId } = (await res.json()) as { queryId: string };
    await ctx.services.registry.get(queryId)!.settled;

    writeFileSync(
      join(reloadTempDir, 'datasources.yaml'),
      `datasources:
  - id: trino-a
    type: trino
    username: admin
    baseUrl: http://trino-reloaded.test
`,
      'utf8',
    );
    await ctx.services.reloadDatasources();
    expect(ctx.services.registry.get(queryId)!.engine.isClosed()).toBe(true);

    const csvRes = await ctx.app.request(`/api/queries/${queryId}/download.csv`);
    expect(csvRes.status).toBe(422);
    const body = (await csvRes.json()) as ApiError;
    expect(body.error.code).toBe(CSV_REEXEC_UNAVAILABLE);
    expect(body.error.message).toBe(
      'Full CSV download requires re-execution but the original datasource connection is no longer available.',
    );
    const auditRows = await ctx.services.audit.listForTest();
    const csvAudit = auditRows.find((row) => row.action === 'csv.download');
    expect(csvAudit?.detail).toMatchObject({
      outcome: 'denied',
      reason: 'csvReexecUnavailable',
      errorCode: CSV_REEXEC_UNAVAILABLE,
      needsReexec: true,
      allowsReexec: true,
      truncated: true,
    });
    await ctx.services.shutdown();
  });

  it('keeps the CSV unavailable message when the engine closes after the guard', async () => {
    const ctx = await createTestContext({
      scenarios: [manyRowScenario(10)],
      configOverrides: { query: { maxRows: 2 } as never },
    });
    const res = await ctx.app.request('/api/queries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ statement: 'SELECT * FROM many', maxRows: 2 }),
    });
    const { queryId } = (await res.json()) as { queryId: string };
    const exec = ctx.services.registry.get(queryId)!;
    await exec.settled;
    const isClosed = vi.spyOn(exec.engine, 'isClosed');
    isClosed.mockReset();
    isClosed.mockReturnValueOnce(false).mockReturnValueOnce(true);

    const csvRes = await ctx.app.request(`/api/queries/${queryId}/download.csv`);
    expect(csvRes.status).toBe(422);
    const body = (await csvRes.json()) as ApiError;
    expect(body.error.code).toBe(CSV_REEXEC_UNAVAILABLE);
    expect(body.error.message).toBe(
      'Full CSV download requires re-execution but the original datasource connection is no longer available.',
    );
    expect(isClosed).toHaveBeenCalledTimes(2);
    await ctx.services.shutdown();
  });
});

/** Minimal central-directory zip reader (single or few stored/deflated entries). */
async function unzip(buf: Buffer): Promise<Record<string, Buffer>> {
  const yauzl = await import('yauzl');
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) return reject(err ?? new Error('no zipfile'));
      const out: Record<string, Buffer> = {};
      zipfile.on('entry', (entry) => {
        zipfile.openReadStream(entry, (e, rs) => {
          if (e || !rs) return reject(e ?? new Error('no read stream'));
          const chunks: Buffer[] = [];
          rs.on('data', (d) => chunks.push(d as Buffer));
          rs.on('end', () => {
            out[entry.fileName] = Buffer.concat(chunks);
            zipfile.readEntry();
          });
          rs.on('error', reject);
        });
      });
      zipfile.on('end', () => resolve(out));
      zipfile.on('error', reject);
      zipfile.readEntry();
    });
  });
}
