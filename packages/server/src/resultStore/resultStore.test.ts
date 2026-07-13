import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import type { QueryRowsPage, QuerySnapshot } from '@hubble/contracts';
import { createTestContext } from '../test/harness';
import type { FakeScenario } from '../test/fakeTrino';
import {
  memoryResultStoreValidator,
  memoryResultStoreVersionId,
  readMemoryResultRange,
  validateMemoryResultRequest,
} from '../test/memoryResultStore';
import {
  NoneResultStore,
  RESULT_STORE_MAX_RANGE_BYTES,
  ResultStoreError,
  type DeleteExpiredResult,
  type ExpiredResultObject,
  type ResultStoreRequestOptions,
  type ResultStore,
} from './store';
import {
  openPersistedResult,
  readPersistedResultMetadata,
  readPersistedRowsPage,
  ResultJsonlCapture,
  streamPersistedCsv,
  streamPersistedResultEvents,
} from './jsonl';
import { S3ResultStore, buildS3ClientConfig } from './s3';
import type { HistoryResultRef } from '../store/history';
import { ResultObjectDeletionRepository } from '../store/resultObjectDeletions';

const COLUMNS = [
  { name: 'id', type: 'bigint' },
  { name: 'note', type: 'varchar' },
];

function s3ServiceError(status: number): S3ServiceException {
  return new S3ServiceException({
    name: `S3Status${status}`,
    $fault: 'client',
    $metadata: { httpStatusCode: status },
    message: `S3 status ${status}`,
  });
}

function expectedResultStoreErrorCode(status: number): string {
  if (status === 404) return 'not_found';
  if (status === 412) return 'precondition_failed';
  if (status === 416) return 'range_not_satisfiable';
  return 'backend_error';
}

function manyRows(rowCount: number): FakeScenario {
  return {
    match: 'persist',
    trinoId: 'persist',
    pages: Array.from({ length: rowCount }, (_, i) => ({
      columns: i === 0 ? COLUMNS : undefined,
      data: [[i, `note_${i}`]],
      state: i === rowCount - 1 ? 'FINISHED' : 'RUNNING',
    })),
  };
}

class MemoryResultStore implements ResultStore {
  readonly enabled = true;
  readonly objects = new Map<string, Buffer>();
  readonly deleted: string[] = [];

  async put(key: string, body: Readable): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk as Buffer));
    this.objects.set(key, Buffer.concat(chunks));
  }

  async getStream(key: string): Promise<Readable> {
    const object = this.objects.get(key);
    if (!object) throw new Error(`missing object: ${key}`);
    return Readable.from(object);
  }

  async stat(key: string, options?: ResultStoreRequestOptions) {
    const object = this.objects.get(key);
    if (!object) throw new Error(`missing object: ${key}`);
    validateMemoryResultRequest(key, object, options);
    return {
      size: object.length,
      validator: memoryResultStoreValidator(object),
      versionId: memoryResultStoreVersionId(object),
    };
  }

  async readRange(
    key: string,
    offset: number,
    length: number,
    options?: ResultStoreRequestOptions,
  ): Promise<Buffer> {
    const object = this.objects.get(key);
    if (!object) throw new Error(`missing object: ${key}`);
    return readMemoryResultRange(key, object, offset, length, options);
  }

  async delete(key: string): Promise<void> {
    this.deleted.push(key);
    this.objects.delete(key);
  }

  async deleteExpired(objects: ExpiredResultObject[]): Promise<DeleteExpiredResult> {
    const deleted: string[] = [];
    for (const object of objects) {
      await this.delete(object.key);
      deleted.push(object.key);
    }
    return { deleted, failed: [] };
  }

  async close(): Promise<void> {}
}

async function submitPersistQuery(
  ctx: Awaited<ReturnType<typeof createTestContext>>,
): Promise<string> {
  const res = await ctx.app.request('/api/queries', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ statement: 'SELECT * FROM persist', maxRows: 5 }),
  });
  expect(res.status).toBe(202);
  const { queryId } = (await res.json()) as { queryId: string };
  await ctx.services.registry.get(queryId)!.settled;
  return queryId;
}

async function waitForResultRef(
  ctx: Awaited<ReturnType<typeof createTestContext>>,
  queryId: string,
  owner = 'admin',
): Promise<HistoryResultRef> {
  for (let i = 0; i < 20; i++) {
    const ref = await ctx.services.history.getResultRef(owner, queryId);
    if (ref) return ref;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('result ref was not recorded');
}

function dropExecution(ctx: Awaited<ReturnType<typeof createTestContext>>, queryId: string): void {
  const registry = ctx.services.registry as unknown as {
    executions: Map<string, unknown>;
  };
  registry.executions.delete(queryId);
}

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe('ResultStore persistence', () => {
  it('waits for background result persistence during QueryService drain', async () => {
    let releaseUpload!: () => void;
    const uploadGate = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const store = new MemoryResultStore();
    const originalPut = store.put.bind(store);
    vi.spyOn(store, 'put').mockImplementation(async (key, body) => {
      await uploadGate;
      await originalPut(key, body);
    });
    const ctx = await createTestContext({ scenarios: [manyRows(2)], resultStore: store });
    await submitPersistQuery(ctx);

    let drained = false;
    const draining = ctx.services.queries.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    releaseUpload();
    await draining;
    expect(drained).toBe(true);
  });

  it('does not start result upload while a query waits for an execution slot', async () => {
    let releaseAdvance!: () => void;
    const advanceGate = new Promise<void>((resolve) => {
      releaseAdvance = resolve;
    });
    const store = new MemoryResultStore();
    const put = vi.spyOn(store, 'put');
    const ctx = await createTestContext({
      scenarios: [manyRows(2)],
      resultStore: store,
      configOverrides: {
        query: {
          concurrency: 1,
          maxQueued: 2,
          maxQueuedPerPrincipal: 2,
        } as never,
      },
    });
    ctx.fake.holdAdvance = advanceGate;

    const submit = async (): Promise<string> => {
      const response = await ctx.app.request('/api/queries', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ statement: 'SELECT * FROM persist' }),
      });
      expect(response.status).toBe(202);
      return ((await response.json()) as { queryId: string }).queryId;
    };
    const firstId = await submit();
    await vi.waitFor(() => expect(put).toHaveBeenCalledOnce());
    const queuedId = await submit();
    expect(ctx.services.registry.get(queuedId)?.state).toBe('queued');
    expect(put).toHaveBeenCalledOnce();

    await ctx.services.registry.get(queuedId)!.requestCancel();
    await ctx.services.registry.get(queuedId)!.settled;
    expect(put).toHaveBeenCalledOnce();
    releaseAdvance();
    await ctx.services.registry.get(firstId)!.settled;
  });

  it('waits for downstream drain without retaining one promise per row', async () => {
    let releaseUpload!: () => void;
    const uploadGate = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const objects = new Map<string, Buffer>();
    const store: ResultStore = {
      enabled: true,
      async put(key, body) {
        await uploadGate;
        const chunks: Buffer[] = [];
        for await (const chunk of body) chunks.push(Buffer.from(chunk as Buffer));
        objects.set(key, Buffer.concat(chunks));
      },
      async getStream(key) {
        return Readable.from(objects.get(key) ?? Buffer.alloc(0));
      },
      async stat(key) {
        return { size: objects.get(key)?.length ?? 0 };
      },
      async readRange(key, offset, length) {
        return Buffer.from((objects.get(key) ?? Buffer.alloc(0)).subarray(offset, offset + length));
      },
      async delete() {},
      async deleteExpired() {
        return { deleted: [], failed: [] };
      },
      async close() {},
    };
    const capture = new ResultJsonlCapture(store, 'blocked.jsonl.gz');
    capture.writeColumns(COLUMNS);
    const largeValue = randomBytes(2 * 1024 * 1024).toString('base64');
    let resolved = false;
    const writing = capture.writeRows([[1, largeValue]]).then(() => {
      resolved = true;
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(resolved).toBe(false);
    expect(Object.hasOwn(capture, 'writes')).toBe(false);

    releaseUpload();
    await writing;
    await capture.finish();
    expect(objects.has('blocked.jsonl.gz')).toBe(true);
  });

  it('writes and reads a zstd JSONL object with the native node:zlib codec', async () => {
    const store = new MemoryResultStore();
    const key = 'hubble-results/native-zstd.jsonl.zst';
    const capture = new ResultJsonlCapture(store, key);
    capture.writeColumns(COLUMNS);
    await capture.writeRows([
      [1, 'one'],
      [2, 'two'],
    ]);
    await capture.finish();

    const page = await readPersistedRowsPage(await store.getStream(key), 0, 10, { key });

    expect(capture.format).toBe('jsonl.zst');
    expect(page.columns).toEqual(COLUMNS);
    expect(page.rows).toEqual([
      [1, 'one'],
      [2, 'two'],
    ]);
    expect(page.totalRows).toBe(2);
  });

  it('uses the zstd dual reader for metadata, cursor, CSV, and result events', async () => {
    const store = new MemoryResultStore();
    const key = 'hubble-results/dual-reader.jsonl.zst';
    const capture = new ResultJsonlCapture(store, key);
    capture.writeColumns(COLUMNS);
    await capture.writeRows([[1, 'one']]);
    await capture.finish();

    const metadata = await readPersistedResultMetadata(await store.getStream(key), { key });
    const cursor = await openPersistedResult(await store.getStream(key), { key });
    const rows: unknown[][] = [];
    for await (const row of cursor.rows) rows.push(row);
    const csv: string[] = [];
    for await (const chunk of streamPersistedCsv(await store.getStream(key), { key }))
      csv.push(chunk);
    const events: unknown[] = [];
    for await (const event of streamPersistedResultEvents(await store.getStream(key), undefined, {
      key,
    })) {
      events.push(event);
    }

    expect(metadata.columns).toEqual(COLUMNS);
    expect(rows).toEqual([[1, 'one']]);
    expect(csv.join('')).toBe('id,note\r\n1,one\r\n');
    expect(events).toEqual([
      { type: 'columns', columns: COLUMNS },
      { type: 'row', row: [1, 'one'] },
    ]);
  });

  it.each([
    { name: 'gzip', key: 'hubble-results/table-gzip.jsonl.gz' },
    { name: 'zstd', key: 'hubble-results/table-zstd.jsonl.zst' },
  ])('runs the same reader group for $name objects', async ({ key }) => {
    const store = new MemoryResultStore();
    const capture = new ResultJsonlCapture(store, key);
    capture.writeColumns(COLUMNS);
    await capture.writeRows([[7, 'seven']]);
    await capture.finish();
    const options = { key, format: capture.format };

    const metadata = await readPersistedResultMetadata(await store.getStream(key), options);
    const page = await readPersistedRowsPage(await store.getStream(key), 0, 10, options);
    const cursor = await openPersistedResult(await store.getStream(key), options);
    const rows: unknown[][] = [];
    for await (const row of cursor.rows) rows.push(row);
    const csv: string[] = [];
    for await (const chunk of streamPersistedCsv(await store.getStream(key), options))
      csv.push(chunk);
    const events: unknown[] = [];
    for await (const event of streamPersistedResultEvents(
      await store.getStream(key),
      undefined,
      options,
    )) {
      events.push(event);
    }

    expect(metadata.columns).toEqual(COLUMNS);
    expect(page.rows).toEqual([[7, 'seven']]);
    expect(rows).toEqual([[7, 'seven']]);
    expect(csv.join('')).toBe('id,note\r\n7,seven\r\n');
    expect(events).toEqual([
      { type: 'columns', columns: COLUMNS },
      { type: 'row', row: [7, 'seven'] },
    ]);
  });

  it.each([
    {
      contentKey: 'hubble-results/priority-gzip.jsonl.gz',
      format: 'jsonl.gz' as const,
      readKey: 'hubble-results/wrong-extension.jsonl.zst',
    },
    {
      contentKey: 'hubble-results/priority-zstd.jsonl.zst',
      format: 'jsonl.zst' as const,
      readKey: 'hubble-results/wrong-extension.jsonl.gz',
    },
  ])('uses format before an opposite key extension', async ({ contentKey, format, readKey }) => {
    const store = new MemoryResultStore();
    const capture = new ResultJsonlCapture(store, contentKey);
    capture.writeColumns(COLUMNS);
    await capture.writeRows([[8, 'eight']]);
    await capture.finish();

    const options = { format, key: readKey };
    const metadata = await readPersistedResultMetadata(await store.getStream(contentKey), options);
    const page = await readPersistedRowsPage(await store.getStream(contentKey), 0, 10, options);

    expect(metadata.columns).toEqual(COLUMNS);
    expect(page.rows).toEqual([[8, 'eight']]);
  });

  it('streams all rows to fake ResultStore and records the history object key', async () => {
    const store = new MemoryResultStore();
    const ctx = await createTestContext({
      scenarios: [manyRows(20)],
      resultStore: store,
      configOverrides: { query: { maxRows: 5 } as never },
    });

    const queryId = await submitPersistQuery(ctx);
    const ref = await waitForResultRef(ctx, queryId);
    expect(ref.resultObjectKey).toBe(`hubble-results/${queryId}.jsonl.zst`);
    expect(ref.rowCount).toBe(20);
    expect(ref.columns).toEqual(COLUMNS);
    expect(ref.format).toBe('jsonl.zst');
    expect(new Date(ref.resultExpiresAt).getTime()).toBeGreaterThan(Date.now());

    const page = await readPersistedRowsPage(await store.getStream(ref.resultObjectKey), 18, 5, {
      format: ref.format,
      key: ref.resultObjectKey,
    });
    expect(page.columns).toEqual(COLUMNS);
    expect(page.totalRows).toBe(20);
    expect(page.rows).toEqual([
      [18, 'note_18'],
      [19, 'note_19'],
    ]);
  });

  it('records a finished history row while result upload is still pending', async () => {
    let releaseUpload!: () => void;
    const uploadGate = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const store = new MemoryResultStore();
    const originalPut = store.put.bind(store);
    vi.spyOn(store, 'put').mockImplementation(async (key, body) => {
      await uploadGate;
      await originalPut(key, body);
    });
    const ctx = await createTestContext({ scenarios: [manyRows(3)], resultStore: store });

    const queryId = await submitPersistQuery(ctx);
    await vi.waitFor(async () => {
      const entry = await ctx.services.history.get('admin', queryId);
      expect(entry).toMatchObject({ id: queryId, state: 'finished', rowCount: 3 });
    });

    releaseUpload();
    await ctx.services.queries.drain();
  });

  it('atomically records terminal history fields with the result link', async () => {
    let currentTime = Date.now();
    const store = new MemoryResultStore();
    const ctx = await createTestContext({
      scenarios: [manyRows(3)],
      resultStore: store,
      now: () => {
        currentTime += 10;
        return currentTime;
      },
    });
    let releaseUpdate!: () => void;
    const updateGate = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    const update = vi
      .spyOn(ctx.services.history, 'update')
      .mockImplementation(async () => updateGate);

    const queryId = await submitPersistQuery(ctx);
    const ref = await waitForResultRef(ctx, queryId);
    const history = await ctx.services.history.list('admin', { limit: 10 });
    const entry = history.items.find((item) => item.id === queryId);
    expect(entry).toMatchObject({
      id: queryId,
      state: 'finished',
      rowCount: 3,
      resultAvailable: true,
      resultExpiresAt: ref.resultExpiresAt,
    });
    expect(entry?.elapsedMs).toBeGreaterThan(0);
    expect(ref.state).toBe('finished');
    expect(ref.rowCount).toBe(3);
    expect(ref.columns).toEqual(COLUMNS);
    expect(ref.format).toBe('jsonl.zst');
    expect(update).toHaveBeenCalledOnce();

    dropExecution(ctx, queryId);
    const snapshot = await ctx.app.request(`/api/queries/${queryId}`);
    expect(snapshot.status).toBe(200);
    expect((await snapshot.json()) as { state: string; rowCount: number }).toMatchObject({
      state: 'finished',
      rowCount: 3,
    });

    releaseUpdate();
    await ctx.services.queries.drain();
  });

  it('query result の DB 関連付けに失敗した場合は upload 済み object を削除する', async () => {
    const store = new MemoryResultStore();
    const logWarn = vi.fn();
    const ctx = await createTestContext({
      scenarios: [manyRows(3)],
      resultStore: store,
      resultStoreLogWarn: logWarn,
    });
    const linkError = new Error('DB link failed');
    vi.spyOn(ctx.services.history, 'setResultObject').mockRejectedValueOnce(linkError);

    const queryId = await submitPersistQuery(ctx);
    await ctx.services.queries.drain();

    expect(store.deleted).toContain(`hubble-results/${queryId}.jsonl.zst`);
    expect(store.objects.has(`hubble-results/${queryId}.jsonl.zst`)).toBe(false);
    expect(await ctx.services.history.getResultRef('admin', queryId)).toBeUndefined();
    expect(logWarn).toHaveBeenCalledWith('failed to persist query result', linkError);
  });

  it('DB 関連付けと即時削除が失敗した場合は object を outbox へ登録する', async () => {
    const store = new MemoryResultStore();
    vi.spyOn(store, 'delete').mockRejectedValue(new Error('S3 delete unavailable'));
    const ctx = await createTestContext({ scenarios: [manyRows(2)], resultStore: store });
    vi.spyOn(ctx.services.history, 'setResultObject').mockRejectedValueOnce(
      new Error('DB link failed'),
    );

    const queryId = await submitPersistQuery(ctx);
    await ctx.services.queries.drain();

    expect(await new ResultObjectDeletionRepository(ctx.db).listForTest()).toEqual([
      expect.objectContaining({ key: `hubble-results/${queryId}.jsonl.zst` }),
    ]);
  });

  it('DB link の commit 応答だけを失った場合は live object を削除しない', async () => {
    const store = new MemoryResultStore();
    const ctx = await createTestContext({ scenarios: [manyRows(2)], resultStore: store });
    const setResultObject = ctx.services.history.setResultObject.bind(ctx.services.history);
    vi.spyOn(ctx.services.history, 'setResultObject').mockImplementation(async (...args) => {
      await setResultObject(...args);
      throw new Error('commit response lost');
    });

    const queryId = await submitPersistQuery(ctx);
    await ctx.services.queries.drain();

    const key = `hubble-results/${queryId}.jsonl.zst`;
    expect(store.objects.has(key)).toBe(true);
    expect(store.deleted).not.toContain(key);
    expect((await ctx.services.history.getResultRef('admin', queryId))?.resultObjectKey).toBe(key);
    expect(await new ResultObjectDeletionRepository(ctx.db).listForTest()).toEqual([]);
  });

  it('既知の総行数があれば page window 後に gzip 入力を閉じる', async () => {
    const totalRows = 1_000;
    const records = Array.from({ length: totalRows }, (_, index) => ({
      kind: 'record',
      row: [index, randomBytes(64).toString('hex')],
    }));
    const payload = [
      JSON.stringify({ kind: 'columns', columns: COLUMNS }),
      ...records.map((record) => JSON.stringify(record)),
      '',
    ].join('\n');
    const compressed = gzipSync(payload);
    const chunks = Array.from({ length: Math.ceil(compressed.length / 64) }, (_, index) =>
      compressed.subarray(index * 64, (index + 1) * 64),
    );
    let yieldedChunks = 0;
    let sourceClosed = false;
    const stream = Readable.from(
      (async function* () {
        try {
          for (const chunk of chunks) {
            yieldedChunks += 1;
            yield chunk;
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
        } finally {
          sourceClosed = true;
        }
      })(),
    );

    const page = await readPersistedRowsPage(stream, 10, 5, {
      totalRows,
      key: 'legacy.jsonl.gz',
    });

    expect(page.totalRows).toBe(totalRows);
    expect(page.rows.map((row) => row[0])).toEqual([10, 11, 12, 13, 14]);
    expect(yieldedChunks).toBeLessThan(chunks.length);
    expect(stream.destroyed).toBe(true);
    await vi.waitFor(() => expect(sourceClosed).toBe(true));
  });

  it('restores snapshot and rows from ResultStore after registry memory is gone', async () => {
    const store = new MemoryResultStore();
    const ctx = await createTestContext({
      scenarios: [manyRows(12)],
      resultStore: store,
      configOverrides: { query: { maxRows: 3 } as never },
    });
    const queryId = await submitPersistQuery(ctx);
    await waitForResultRef(ctx, queryId);
    const getStream = vi.spyOn(store, 'getStream');
    dropExecution(ctx, queryId);

    const snapRes = await ctx.app.request(`/api/queries/${queryId}`);
    expect(snapRes.status).toBe(200);
    const snap = (await snapRes.json()) as QuerySnapshot;
    expect(snap.columns).toEqual(COLUMNS);
    expect(snap.rowCount).toBe(12);
    expect(snap.datasourceId).toBe('trino-default');
    expect(getStream).not.toHaveBeenCalled();

    const rowsRes = await ctx.app.request(`/api/queries/${queryId}/rows?offset=10&limit=5`);
    expect(rowsRes.status).toBe(200);
    const page = (await rowsRes.json()) as QueryRowsPage;
    expect(page.complete).toBe(true);
    expect(page.totalBuffered).toBe(12);
    expect(page.rows).toEqual([
      [10, 'note_10'],
      [11, 'note_11'],
    ]);
  });

  it('falls back to JSONL metadata for an old result object without saved columns', async () => {
    const store = new MemoryResultStore();
    const ctx = await createTestContext({ scenarios: [manyRows(4)], resultStore: store });
    const queryId = await submitPersistQuery(ctx);
    await waitForResultRef(ctx, queryId);
    await ctx.db.run('UPDATE query_history SET result_columns_json = NULL WHERE id = ?', [queryId]);
    const getStream = vi.spyOn(store, 'getStream');
    dropExecution(ctx, queryId);

    const response = await ctx.app.request(`/api/queries/${queryId}`);

    expect(response.status).toBe(200);
    expect(((await response.json()) as { columns?: unknown }).columns).toEqual(COLUMNS);
    expect(getStream).toHaveBeenCalledOnce();
  });

  it('uses an explicit history list projection without result metadata columns', async () => {
    const store = new MemoryResultStore();
    const ctx = await createTestContext({ scenarios: [manyRows(1)], resultStore: store });
    await submitPersistQuery(ctx);
    const query = vi.spyOn(ctx.db, 'query');

    await ctx.services.history.list('admin', { limit: 10 });

    const listSql = query.mock.calls
      .map(([sql]) => String(sql))
      .find((sql) => sql.includes('ORDER BY submitted_at DESC, id DESC'));
    expect(listSql).toBeDefined();
    expect(listSql).toContain('SELECT id, statement, catalog, schema, trino_query_id');
    expect(listSql).not.toContain('result_columns_json');
  });

  it('uses persisted CSV before the truncated re-exec path', async () => {
    const store = new MemoryResultStore();
    const ctx = await createTestContext({
      scenarios: [manyRows(14)],
      resultStore: store,
      configOverrides: { query: { maxRows: 4 } as never },
    });
    const queryId = await submitPersistQuery(ctx);
    await waitForResultRef(ctx, queryId);
    const postsBefore = ctx.fake.requests.filter((request) => request.method === 'POST').length;

    const csvRes = await ctx.app.request(`/api/queries/${queryId}/download.csv`);
    expect(csvRes.status).toBe(200);
    const lines = (await csvRes.text()).split('\r\n').filter((line) => line !== '');
    expect(lines).toHaveLength(15);
    expect(lines[14]).toBe('13,note_13');
    expect(ctx.fake.requests.filter((request) => request.method === 'POST')).toHaveLength(
      postsBefore,
    );
  });

  it('rechecks datasource allowlist on persisted fallback reads', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'hubble-result-rbac-'));
    writeFileSync(
      join(tempDir, 'rbac.yaml'),
      `roles:
  allowed:
    permissions: [query.write]
    datasources: [trino-default]
  blocked:
    permissions: [query.write]
    datasources: []
assignments:
  - user: alice
    role: allowed
defaultRole: blocked
`,
      'utf8',
    );
    const store = new MemoryResultStore();
    const ctx = await createTestContext({
      cwd: tempDir,
      env: { AUTH_MODE: 'proxy', AUTH_USER_MAPPING: 'user' },
      remoteAddress: () => '127.0.0.1',
      scenarios: [manyRows(8)],
      resultStore: store,
      configOverrides: { query: { maxRows: 2 } as never },
    });
    const headers = {
      'content-type': 'application/json',
      'x-forwarded-user': 'alice',
      'x-forwarded-email': 'alice@example.com',
    };
    const res = await ctx.app.request('/api/queries', {
      method: 'POST',
      headers,
      body: JSON.stringify({ statement: 'SELECT * FROM persist', maxRows: 2 }),
    });
    const { queryId } = (await res.json()) as { queryId: string };
    await ctx.services.registry.get(queryId)!.settled;
    await waitForResultRef(ctx, queryId, 'alice');
    dropExecution(ctx, queryId);

    const allowed = await ctx.app.request(`/api/queries/${queryId}/rows`, { headers });
    expect(allowed.status).toBe(200);

    writeFileSync(
      join(tempDir, 'rbac.yaml'),
      `roles:
  allowed:
    permissions: [query.write]
    datasources: []
assignments:
  - user: alice
    role: allowed
defaultRole: allowed
`,
      'utf8',
    );
    await ctx.services.reloadRbac();
    const denied = await ctx.app.request(`/api/queries/${queryId}/rows`, { headers });
    expect(denied.status).toBe(404);
  });

  it('deletes expired objects and clears DB references', async () => {
    const store = new MemoryResultStore();
    const ctx = await createTestContext({
      scenarios: [manyRows(3)],
      resultStore: store,
    });
    const queryId = await submitPersistQuery(ctx);
    const ref = await waitForResultRef(ctx, queryId);
    await ctx.services.history.setResultObject(
      queryId,
      ref.resultObjectKey,
      '2000-01-01T00:00:00.000Z',
      {
        state: ref.state,
        rowCount: ref.rowCount,
        elapsedMs: ref.elapsedMs,
        trinoQueryId: ref.trinoQueryId,
        errorMessage: ref.errorMessage,
      },
      ref.columns ?? [],
      ref.format ?? 'jsonl.zst',
    );

    await ctx.services.resultExpiry.runOnce();

    expect(store.deleted).toContain(ref.resultObjectKey);
    expect(await ctx.services.history.getResultRef('admin', queryId)).toBeUndefined();
  });

  it('keeps the query finished and omits the result reference when persistence fails', async () => {
    const persistenceError = new Error('result upload failed');
    const store: ResultStore = {
      enabled: true,
      async put(_key, body) {
        for await (const chunk of body) {
          void chunk;
          throw persistenceError;
        }
        throw persistenceError;
      },
      async getStream() {
        throw new Error('not stored');
      },
      async stat() {
        throw new Error('not stored');
      },
      async readRange() {
        throw new Error('not stored');
      },
      async delete() {},
      async deleteExpired() {
        return { deleted: [], failed: [] };
      },
      async close() {},
    };
    const logWarn = vi.fn();
    const ctx = await createTestContext({
      scenarios: [manyRows(3)],
      resultStore: store,
      resultStoreLogWarn: logWarn,
    });

    const queryId = await submitPersistQuery(ctx);
    const exec = ctx.services.registry.get(queryId)!;
    expect(exec.state).toBe('finished');
    await vi.waitFor(() => expect(logWarn).toHaveBeenCalled());
    expect(logWarn.mock.calls[0]?.[1]).toBe(persistenceError);
    expect(await ctx.services.history.getResultRef('admin', queryId)).toBeUndefined();
  });
});

describe('NoneResultStore', () => {
  it('rejects metadata and range reads with an explicit disabled error', async () => {
    const store = new NoneResultStore();

    await expect(store.stat('result.jsonl.zst')).rejects.toThrow(
      'Result store is disabled: result.jsonl.zst',
    );
    await expect(store.readRange('result.jsonl.zst', 0, 1)).rejects.toThrow(
      'Result store is disabled: result.jsonl.zst',
    );
  });
});

describe('S3ResultStore', () => {
  it('builds a path-style client config when endpoint is set', () => {
    expect(
      buildS3ClientConfig({
        bucket: 'bucket',
        region: 'us-west-2',
        endpoint: 'http://localhost:9000',
      }),
    ).toMatchObject({
      region: 'us-west-2',
      endpoint: 'http://localhost:9000',
      forcePathStyle: true,
    });
  });

  it('uses real SDK client and command classes without connecting', async () => {
    const commands: string[] = [];
    const destroy = vi.fn();
    const fakeClient = {
      destroy,
      send: async (command: object) => {
        commands.push(command.constructor.name);
        if (command.constructor.name === 'GetObjectCommand') {
          return { Body: Readable.from(Buffer.from('body')) };
        }
        return {};
      },
    };
    const uploaded: Array<{
      bucket: string;
      key: string;
      body: Readable;
      contentEncoding: string;
    }> = [];
    const store = new S3ResultStore(
      { bucket: 'bucket', region: 'us-east-1' },
      {
        client: fakeClient as never,
        uploadFactory: (params) => ({
          done: async () => {
            uploaded.push({
              bucket: params.bucket,
              key: params.key,
              body: params.body,
              contentEncoding: params.contentEncoding,
            });
          },
        }),
      },
    );

    await store.put('prefix/q.jsonl.gz', Readable.from(Buffer.from('x')));
    await store.put('prefix/q.jsonl.zst', Readable.from(Buffer.from('x')));
    await store.getStream('prefix/q.jsonl.gz');
    await store.delete('prefix/q.jsonl.gz');
    await store.close();

    expect(uploaded).toEqual([
      expect.objectContaining({
        bucket: 'bucket',
        key: 'prefix/q.jsonl.gz',
        contentEncoding: 'gzip',
      }),
      expect.objectContaining({
        bucket: 'bucket',
        key: 'prefix/q.jsonl.zst',
        contentEncoding: 'zstd',
      }),
    ]);
    expect(commands).toEqual(['GetObjectCommand', 'DeleteObjectCommand']);
    expect(destroy).not.toHaveBeenCalled();
  });

  it('returns metadata and an exact raw byte range with validators', async () => {
    const calls: Array<{
      name: string;
      input: Record<string, unknown>;
      abortSignal?: AbortSignal;
    }> = [];
    const abortController = new AbortController();
    const fakeClient = {
      destroy: vi.fn(),
      send: async (
        command: { constructor: { name: string }; input: Record<string, unknown> },
        options?: { abortSignal?: AbortSignal },
      ) => {
        calls.push({
          name: command.constructor.name,
          input: command.input,
          ...(options?.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
        });
        if (command.constructor.name === 'HeadObjectCommand') {
          return { ContentLength: 11, ETag: '"v1"', VersionId: 'version-1' };
        }
        return {
          $metadata: { httpStatusCode: 206 },
          ContentLength: 4,
          ContentRange: 'bytes 2-5/11',
          Body: Readable.from(Buffer.from('2345')),
        };
      },
    };
    const store = new S3ResultStore(
      { bucket: 'bucket', region: 'us-east-1' },
      { client: fakeClient as never },
    );

    await expect(
      store.stat('result.jsonl.zst', {
        signal: abortController.signal,
        validator: '"old"',
        versionId: 'version-0',
      }),
    ).resolves.toEqual({ size: 11, validator: '"v1"', versionId: 'version-1' });
    await expect(
      store.readRange('result.jsonl.zst', 2, 4, {
        signal: abortController.signal,
        validator: '"v1"',
        versionId: 'version-1',
      }),
    ).resolves.toEqual(Buffer.from('2345'));

    expect(calls).toEqual([
      {
        name: 'HeadObjectCommand',
        input: {
          Bucket: 'bucket',
          Key: 'result.jsonl.zst',
          IfMatch: '"old"',
          VersionId: 'version-0',
        },
        abortSignal: abortController.signal,
      },
      {
        name: 'GetObjectCommand',
        input: {
          Bucket: 'bucket',
          Key: 'result.jsonl.zst',
          Range: 'bytes=2-5',
          IfMatch: '"v1"',
          VersionId: 'version-1',
        },
        abortSignal: abortController.signal,
      },
    ]);
  });

  it('keeps getStream as a full object request without Range', async () => {
    let input: Record<string, unknown> | undefined;
    const fakeClient = {
      destroy: vi.fn(),
      send: async (command: { input: Record<string, unknown> }) => {
        input = command.input;
        return { Body: Readable.from(Buffer.from('body')) };
      },
    };
    const store = new S3ResultStore(
      { bucket: 'bucket', region: 'us-east-1' },
      { client: fakeClient as never },
    );

    await store.getStream('result.jsonl.gz');

    expect(input).toEqual({ Bucket: 'bucket', Key: 'result.jsonl.gz' });
  });

  it('rejects a full-body 200 response instead of accepting it as a range', async () => {
    const body = Readable.from(Buffer.from('full body'));
    const fakeClient = {
      destroy: vi.fn(),
      send: async () => ({ $metadata: { httpStatusCode: 200 }, Body: body }),
    };
    const store = new S3ResultStore(
      { bucket: 'bucket', region: 'us-east-1' },
      { client: fakeClient as never },
    );

    await expect(store.readRange('result.jsonl.gz', 0, 4)).rejects.toThrow(/200.*expected 206/);
    expect(body.destroyed).toBe(true);
  });

  it.each([404, 412, 500])(
    'converts S3 stat errors into a stable ResultStoreError (%s)',
    async (status) => {
      const error = s3ServiceError(status);
      const fakeClient = {
        destroy: vi.fn(),
        send: async () => {
          throw error;
        },
      };
      const store = new S3ResultStore(
        { bucket: 'bucket', region: 'us-east-1' },
        { client: fakeClient as never },
      );

      const rejection = store.stat('result.jsonl.gz');
      await expect(rejection).rejects.toBeInstanceOf(ResultStoreError);
      await expect(rejection).rejects.toMatchObject({
        code: expectedResultStoreErrorCode(status),
        operation: 'stat',
        backendStatus: status,
        cause: error,
        message: expect.stringContaining(`stat failed for result.jsonl.gz (HTTP status ${status})`),
      });
    },
  );

  it.each([404, 412, 416, 500])(
    'converts S3 readRange errors into a stable ResultStoreError (%s)',
    async (status) => {
      const error = s3ServiceError(status);
      const fakeClient = {
        destroy: vi.fn(),
        send: async () => {
          throw error;
        },
      };
      const store = new S3ResultStore(
        { bucket: 'bucket', region: 'us-east-1' },
        { client: fakeClient as never },
      );

      const rejection = store.readRange('result.jsonl.gz', 0, 1);
      await expect(rejection).rejects.toBeInstanceOf(ResultStoreError);
      await expect(rejection).rejects.toMatchObject({
        code: expectedResultStoreErrorCode(status),
        operation: 'readRange',
        backendStatus: status,
        cause: error,
        message: expect.stringContaining(
          `readRange failed for result.jsonl.gz (HTTP status ${status})`,
        ),
      });
    },
  );

  it('preserves a non-S3 AbortError without wrapping it', async () => {
    const abortError = new Error('request aborted');
    abortError.name = 'AbortError';
    const fakeClient = {
      destroy: vi.fn(),
      send: async () => {
        throw abortError;
      },
    };
    const store = new S3ResultStore(
      { bucket: 'bucket', region: 'us-east-1' },
      { client: fakeClient as never },
    );

    await expect(store.readRange('result.jsonl.gz', 0, 1)).rejects.toBe(abortError);
  });

  it('rejects a mismatched Content-Range response', async () => {
    const body = Readable.from(Buffer.from('2345'));
    const fakeClient = {
      destroy: vi.fn(),
      send: async () => ({
        $metadata: { httpStatusCode: 206 },
        ContentLength: 4,
        ContentRange: 'bytes 1-4/11',
        Body: body,
      }),
    };
    const store = new S3ResultStore(
      { bucket: 'bucket', region: 'us-east-1' },
      { client: fakeClient as never },
    );

    await expect(store.readRange('result.jsonl.gz', 2, 4)).rejects.toThrow(
      /Content-Range mismatch/,
    );
    expect(body.destroyed).toBe(true);
  });

  it('rejects a short range response body', async () => {
    const fakeClient = {
      destroy: vi.fn(),
      send: async () => ({
        $metadata: { httpStatusCode: 206 },
        ContentLength: 4,
        ContentRange: 'bytes 2-5/11',
        Body: Readable.from(Buffer.from('23')),
      }),
    };
    const store = new S3ResultStore(
      { bucket: 'bucket', region: 'us-east-1' },
      { client: fakeClient as never },
    );

    await expect(store.readRange('result.jsonl.gz', 2, 4)).rejects.toThrow(
      /body length mismatch.*2.*expected 4/,
    );
  });

  it.each([undefined, -1, 1.5, 3])(
    'rejects invalid or mismatched range ContentLength (%s) and destroys the body',
    async (contentLength) => {
      const body = Readable.from(Buffer.from('1234'));
      const fakeClient = {
        destroy: vi.fn(),
        send: async () => ({
          $metadata: { httpStatusCode: 206 },
          ...(contentLength === undefined ? {} : { ContentLength: contentLength }),
          ContentRange: 'bytes 0-3/4',
          Body: body,
        }),
      };
      const store = new S3ResultStore(
        { bucket: 'bucket', region: 'us-east-1' },
        { client: fakeClient as never },
      );

      await expect(store.readRange('result.jsonl.gz', 0, 4)).rejects.toThrow(
        contentLength === 3 ? /ContentLength mismatch/ : /invalid ContentLength/,
      );
      expect(body.destroyed).toBe(true);
    },
  );

  it('destroys a range body that exceeds the requested length while reading', async () => {
    const body = Readable.from([Buffer.from('1234'), Buffer.from('56')]);
    const fakeClient = {
      destroy: vi.fn(),
      send: async () => ({
        $metadata: { httpStatusCode: 206 },
        ContentLength: 4,
        ContentRange: 'bytes 0-3/6',
        Body: body,
      }),
    };
    const store = new S3ResultStore(
      { bucket: 'bucket', region: 'us-east-1' },
      { client: fakeClient as never },
    );

    await expect(store.readRange('result.jsonl.gz', 0, 4)).rejects.toThrow(
      /body length mismatch.*6.*expected 4/,
    );
    expect(body.destroyed).toBe(true);
  });

  it('rejects a range response whose body is not a Node stream', async () => {
    const fakeClient = {
      destroy: vi.fn(),
      send: async () => ({
        $metadata: { httpStatusCode: 206 },
        ContentLength: 4,
        ContentRange: 'bytes 0-3/4',
        Body: new Uint8Array([1, 2, 3, 4]),
      }),
    };
    const store = new S3ResultStore(
      { bucket: 'bucket', region: 'us-east-1' },
      { client: fakeClient as never },
    );

    await expect(store.readRange('result.jsonl.gz', 0, 4)).rejects.toThrow(
      /body is not a Node stream/,
    );
  });

  it.each([undefined, 'bytes malformed/11', 'bytes 0-3/3'])(
    'rejects missing, malformed, or undersized Content-Range (%s)',
    async (contentRange) => {
      const fakeClient = {
        destroy: vi.fn(),
        send: async () => ({
          $metadata: { httpStatusCode: 206 },
          ContentLength: 4,
          ...(contentRange === undefined ? {} : { ContentRange: contentRange }),
          Body: Readable.from(Buffer.from('1234')),
        }),
      };
      const store = new S3ResultStore(
        { bucket: 'bucket', region: 'us-east-1' },
        { client: fakeClient as never },
      );

      await expect(store.readRange('result.jsonl.gz', 0, 4)).rejects.toThrow(
        /Content-Range mismatch/,
      );
    },
  );

  it('rejects invalid ranges before sending a command', async () => {
    const send = vi.fn();
    const store = new S3ResultStore(
      { bucket: 'bucket', region: 'us-east-1' },
      { client: { destroy: vi.fn(), send } as never },
    );

    await expect(store.readRange('result.jsonl.gz', -1, 1)).rejects.toThrow(/range offset/);
    await expect(store.readRange('result.jsonl.gz', 0, 0)).rejects.toThrow(/range length/);
    await expect(
      store.readRange('result.jsonl.gz', 0, RESULT_STORE_MAX_RANGE_BYTES + 1),
    ).rejects.toThrow(/exceeds maximum/);
    await expect(store.readRange('result.jsonl.gz', Number.MAX_SAFE_INTEGER, 2)).rejects.toThrow(
      /range overflow/,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it.each([undefined, -1, 1.5])(
    'rejects missing or invalid HEAD ContentLength (%s)',
    async (size) => {
      const fakeClient = {
        destroy: vi.fn(),
        send: async () => ({
          ETag: '"v1"',
          ...(size === undefined ? {} : { ContentLength: size }),
        }),
      };
      const store = new S3ResultStore(
        { bucket: 'bucket', region: 'us-east-1' },
        { client: fakeClient as never },
      );

      await expect(store.stat('result.jsonl.gz')).rejects.toThrow(/invalid ContentLength/);
    },
  );

  it.each([412, 416])('includes the HTTP status in range errors (%s)', async (status) => {
    const fakeClient = {
      destroy: vi.fn(),
      send: async () => ({ $metadata: { httpStatusCode: status } }),
    };
    const store = new S3ResultStore(
      { bucket: 'bucket', region: 'us-east-1' },
      { client: fakeClient as never },
    );

    await expect(store.readRange('result.jsonl.gz', 0, 1)).rejects.toThrow(
      new RegExp(`status ${status}`),
    );
  });

  it('期限切れ object を最大8並行で削除する', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fakeClient = {
      destroy: vi.fn(),
      send: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        inFlight -= 1;
        return {};
      },
    };
    const store = new S3ResultStore(
      { bucket: 'bucket', region: 'us-east-1' },
      { client: fakeClient as never },
    );

    const result = await store.deleteExpired(
      Array.from({ length: 20 }, (_, index) => ({ key: `result-${index}` })),
    );

    expect(result.failed).toEqual([]);
    expect(result.deleted).toHaveLength(20);
    expect(maxInFlight).toBe(8);
  });

  it('destroys only its internally created SDK client and closes idempotently', async () => {
    const destroy = vi.spyOn(S3Client.prototype, 'destroy').mockImplementation(() => undefined);
    try {
      const store = new S3ResultStore({ bucket: 'bucket', region: 'us-east-1' });

      await store.close();
      await store.close();

      expect(destroy).toHaveBeenCalledOnce();
    } finally {
      destroy.mockRestore();
    }
  });
});
