import { describe, it, expect } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { csvField, csvRecord, streamCsvReexec } from './csv';
import { createTestContext } from '../test/harness';
import type { FakeScenario } from '../test/fakeTrino';

describe('csvField (RFC 4180 quoting)', () => {
  it('leaves simple values unquoted', () => {
    expect(csvField('abc')).toBe('abc');
    expect(csvField(42)).toBe('42');
    expect(csvField(true)).toBe('true');
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

    // Drive the re-execution generator directly so we can abort mid-stream and
    // assert the teardown DELETE fires (Hono's in-process request doesn't model
    // a real client disconnect reliably).
    const ac = new AbortController();
    const gen = streamCsvReexec(
      exec,
      { client: ctx.services.trino, signal: ac.signal },
      { flushEvery: 1 },
    );
    // Pull the first chunk (flushEvery=1 yields after page 1, parked at a live
    // nextUri), then abort and close the generator to trigger its finally{}
    // teardown DELETE.
    await gen.next();
    ac.abort();
    await gen.return(undefined);

    const deletes = ctx.fake.requests.filter((r) => r.method === 'DELETE');
    expect(deletes.length).toBeGreaterThanOrEqual(1);
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
