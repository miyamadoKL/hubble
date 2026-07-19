import { randomBytes } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import { zstdCompressSync } from 'node:zlib';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { S3Client } from '@aws-sdk/client-s3';
import type { QueryRowsPage, QuerySnapshot } from '@hubble/contracts';
import { createTestContext } from '../test/harness';
import type { FakeScenario } from '../test/fakeTrino';
import {
  NoneResultStore,
  type DeleteExpiredResult,
  type ExpiredResultObject,
  type ResultStore,
} from './store';
import {
  openPersistedResult,
  readPersistedRowsPage,
  ResultJsonlCapture,
  RESULT_JSONL_WRITE_CHUNK_BYTES,
  streamPersistedResultEvents,
} from './jsonl';
import { S3ResultStore, buildS3ClientConfig } from './s3';
import type { ResultStoreMetric } from './observability';
import type { HistoryResultRef } from '../store/history';
import { ResultObjectDeletionRepository } from '../store/resultObjectDeletions';
import { csvFromEvents } from '../query/csv';

const COLUMNS = [
  { name: 'id', type: 'bigint' },
  { name: 'note', type: 'varchar' },
];

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
  // 結果永続化はQueryServiceがqueryIdごとにバックグラウンドタスクとして追跡して
  // おり、`waitForResultPersisted()` はそのタスクの完了を確定的に待てる(履歴更新
  // など無関係な他のバックグラウンドタスクは待たない)。以前は固定10ms間隔・
  // 最大20回のポーリングだったため、CPU負荷が高い並列実行下ではバックグラウンド
  // 書き込みが間に合わず "result ref was not recorded" で timeout するflakeが
  // あった。なお `drain()` は履歴更新タスクも含めて待つため粒度が粗すぎ、履歴
  // 更新を意図的にブロックするテスト(「atomically records terminal history
  // fields with the result link」等)ではデッドロックしてしまう。
  await ctx.services.queries.waitForResultPersisted(queryId);
  const ref = await ctx.services.history.getResultRef(owner, queryId);
  if (!ref) throw new Error('result ref was not recorded');
  return ref;
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
      async delete() {},
      async deleteExpired() {
        return { deleted: [], failed: [] };
      },
      async close() {},
    };
    const capture = new ResultJsonlCapture(store, 'blocked.jsonl.zst');
    const input = (
      capture as unknown as {
        input: { write: (payload: string | Buffer) => boolean };
      }
    ).input;
    const write = vi.spyOn(input, 'write');
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
    expect(objects.has('blocked.jsonl.zst')).toBe(true);
    expect(
      write.mock.calls.every(([payload]) =>
        Buffer.isBuffer(payload)
          ? payload.byteLength <= RESULT_JSONL_WRITE_CHUNK_BYTES
          : Buffer.byteLength(payload) <= RESULT_JSONL_WRITE_CHUNK_BYTES,
      ),
    ).toBe(true);
  });

  it('counts a large record once across bounded writer chunks', async () => {
    const events: ResultStoreMetric[] = [];
    const store = new MemoryResultStore();
    const key = 'large-row.jsonl.zst';
    const largeRow = [1, 'x'.repeat(RESULT_JSONL_WRITE_CHUNK_BYTES * 3)];
    let currentTime = 100;
    const capture = new ResultJsonlCapture(store, key, {
      observer: (event) => events.push(event),
      clock: () => ++currentTime,
    });
    capture.writeColumns(COLUMNS);
    await capture.writeRows([largeRow]);
    await capture.finish();

    const page = await readPersistedRowsPage(await store.getStream(key), 0, 1);
    expect(page.columns).toEqual(COLUMNS);
    expect(page.rows).toEqual([largeRow]);

    const event = events.find((entry) => entry.kind === 'write');
    expect(event).toMatchObject({ kind: 'write', rows: 1, outcome: 'success' });
    if (!event || event.kind !== 'write') throw new Error('writer event was not recorded');
    const columnsLine = `${JSON.stringify({ kind: 'columns', columns: COLUMNS })}\n`;
    const recordLine = `${JSON.stringify({ kind: 'record', row: largeRow })}\n`;
    expect(event.uncompressedBytes).toBe(Buffer.byteLength(columnsLine + recordLine));
    expect(event.compressedBytes).toBeGreaterThan(0);
    expect(event.durationMs).toBeGreaterThan(0);
  });

  it('waits for a failed upload even when abort follows failure notification', async () => {
    let releaseUpload!: () => void;
    const uploadGate = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    let uploadStarted!: () => void;
    const uploadStartedPromise = new Promise<void>((resolve) => {
      uploadStarted = resolve;
    });
    const events: ResultStoreMetric[] = [];
    const store: ResultStore = {
      enabled: true,
      async put(_key, body) {
        uploadStarted();
        await uploadGate;
        for await (const chunk of body) void chunk;
      },
      async getStream() {
        throw new Error('not stored');
      },
      async delete() {},
      async deleteExpired() {
        return { deleted: [], failed: [] };
      },
      async close() {},
    };
    const capture = new ResultJsonlCapture(store, 'failed-abort.jsonl.zst', {
      observer: (event) => events.push(event),
      clock: () => 1,
    });
    await uploadStartedPromise;

    const failure = new Error('upload failed');
    const input = capture as unknown as {
      input: { emit: (event: string, error: Error) => boolean };
    };
    input.input.emit('error', failure);

    let aborted = false;
    const aborting = capture.abort().then(() => {
      aborted = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(aborted).toBe(false);

    releaseUpload();
    await aborting;
    expect(events).toContainEqual(expect.objectContaining({ kind: 'write', outcome: 'failure' }));
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

    const page = await readPersistedRowsPage(await store.getStream(key), 0, 10);

    expect(page.columns).toEqual(COLUMNS);
    expect(page.rows).toEqual([
      [1, 'one'],
      [2, 'two'],
    ]);
    expect(page.totalRows).toBe(2);
  });

  it('batches a page into bounded JSONL payloads while preserving rows', async () => {
    const store = new MemoryResultStore();
    const capture = new ResultJsonlCapture(store, 'hubble-results/batched.jsonl.zst');
    const input = (
      capture as unknown as {
        input: { write: (payload: string | Buffer) => boolean };
      }
    ).input;
    const write = vi.spyOn(input, 'write');
    capture.writeColumns(COLUMNS);
    await capture.writeRows(Array.from({ length: 3_000 }, (_, index) => [index, `note_${index}`]));
    await capture.finish();

    const payloads = write.mock.calls.map(([payload]) => payload);
    expect(payloads.length).toBeGreaterThan(2);
    expect(
      payloads.every((payload) =>
        Buffer.isBuffer(payload)
          ? payload.byteLength <= RESULT_JSONL_WRITE_CHUNK_BYTES
          : Buffer.byteLength(payload) <= RESULT_JSONL_WRITE_CHUNK_BYTES,
      ),
    ).toBe(true);
    const page = await readPersistedRowsPage(
      await store.getStream('hubble-results/batched.jsonl.zst'),
      2_999,
      1,
    );
    expect(page.rows).toEqual([[2_999, 'note_2999']]);
  });

  it('rejects record-first, duplicate-columns, and empty JSONL objects', async () => {
    const compressed = (lines: string): Readable =>
      Readable.from(zstdCompressSync(Buffer.from(`${lines}\n`)));
    const columns = JSON.stringify({ kind: 'columns', columns: COLUMNS });
    const record = JSON.stringify({ kind: 'record', row: [1, 'one'] });

    await expect(readPersistedRowsPage(compressed(record), 0, 10)).rejects.toThrow(
      'must start with a columns line',
    );
    await expect(
      readPersistedRowsPage(compressed(`${columns}\n${columns}`), 0, 10),
    ).rejects.toThrow('duplicate columns line');
    await expect(readPersistedRowsPage(compressed(''), 0, 10)).rejects.toThrow(
      'missing columns line',
    );
  });

  it('prioritizes SQL abort over missing columns before the first JSONL line', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      readPersistedRowsPage(Readable.from(zstdCompressSync(Buffer.from(''))), 0, 10, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError', message: 'Aborted' });

    const secondController = new AbortController();
    secondController.abort();
    await expect(
      openPersistedResult(Readable.from(zstdCompressSync(Buffer.from(''))), {
        signal: secondController.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError', message: 'Aborted' });
  });

  it('closes the compressed reader when abort happens during a read', async () => {
    const controller = new AbortController();
    const source = new PassThrough();
    const reading = readPersistedRowsPage(source, 0, 10, { signal: controller.signal });

    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();

    await expect(reading).rejects.toMatchObject({ name: 'AbortError', message: 'Aborted' });
    expect(source.destroyed).toBe(true);
  });

  it('records persisted rows metrics with low and high offsets', async () => {
    const compressed = zstdCompressSync(
      Buffer.from(
        [
          JSON.stringify({ kind: 'columns', columns: COLUMNS }),
          JSON.stringify({ kind: 'record', row: [1, 'one'] }),
          JSON.stringify({ kind: 'record', row: [2, 'two'] }),
          JSON.stringify({ kind: 'record', row: [3, 'three'] }),
        ].join('\n') + '\n',
      ),
    );
    const events: ResultStoreMetric[] = [];
    const clock = (): number => 1;

    await readPersistedRowsPage(Readable.from(compressed), 0, 1, {
      totalRows: 3,
      observer: (event) => events.push(event),
      clock,
    });
    await readPersistedRowsPage(Readable.from(compressed), 2, 1, {
      totalRows: 3,
      observer: (event) => events.push(event),
      clock,
    });

    expect(events).toEqual([
      expect.objectContaining({
        kind: 'read',
        operation: 'rows',
        offset: 0,
        scannedRows: 1,
        outcome: 'success',
      }),
      expect.objectContaining({
        kind: 'read',
        operation: 'rows',
        offset: 2,
        scannedRows: 3,
        outcome: 'success',
      }),
    ]);
  });

  it('uses the zstd reader for cursor, CSV, and result events', async () => {
    const store = new MemoryResultStore();
    const key = 'hubble-results/dual-reader.jsonl.zst';
    const capture = new ResultJsonlCapture(store, key);
    capture.writeColumns(COLUMNS);
    await capture.writeRows([[1, 'one']]);
    await capture.finish();

    const cursor = await openPersistedResult(await store.getStream(key));
    const rows: unknown[][] = [];
    for await (const row of cursor.rows) rows.push(row);
    const csv: string[] = [];
    for await (const chunk of csvFromEvents(
      streamPersistedResultEvents(await store.getStream(key)),
    ))
      csv.push(chunk);
    const events: unknown[] = [];
    for await (const event of streamPersistedResultEvents(await store.getStream(key))) {
      events.push(event);
    }

    expect(cursor.columns).toEqual(COLUMNS);
    expect(rows).toEqual([[1, 'one']]);
    expect(csv.join('')).toBe('id,note\r\n1,one\r\n');
    expect(events).toEqual([
      { type: 'columns', columns: COLUMNS },
      { type: 'row', row: [1, 'one'] },
    ]);
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
    expect([...store.objects.keys()]).toEqual([ref.resultObjectKey]);
    expect([...store.objects.keys()].some((key) => key.endsWith('.parquet'))).toBe(false);
    expect(ref.rowCount).toBe(20);
    expect(ref.columns).toEqual(COLUMNS);
    expect(new Date(ref.resultExpiresAt).getTime()).toBeGreaterThan(Date.now());

    const page = await readPersistedRowsPage(await store.getStream(ref.resultObjectKey), 18, 5);
    expect(page.columns).toEqual(COLUMNS);
    expect(page.totalRows).toBe(20);
    expect(page.rows).toEqual([
      [18, 'note_18'],
      [19, 'note_19'],
    ]);
  });

  it('records only persisted query rows, search, and profile reads', async () => {
    const events: ResultStoreMetric[] = [];
    let currentTime = 0;
    const store = new MemoryResultStore();
    const ctx = await createTestContext({
      scenarios: [manyRows(3)],
      resultStore: store,
      resultStoreObserver: (event) => events.push(event),
      resultStoreClock: () => ++currentTime,
    });
    const queryId = await submitPersistQuery(ctx);
    await waitForResultRef(ctx, queryId);
    dropExecution(ctx, queryId);

    await expect(
      ctx.app.request(`/api/queries/${queryId}/rows?offset=0&limit=1`),
    ).resolves.toHaveProperty('status', 200);
    await expect(
      ctx.app.request(`/api/queries/${queryId}/rows/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ offset: 0, limit: 1 }),
      }),
    ).resolves.toHaveProperty('status', 200);
    await expect(ctx.app.request(`/api/queries/${queryId}/profile`)).resolves.toHaveProperty(
      'status',
      200,
    );

    expect(events.filter((event) => event.kind === 'read').map((event) => event.operation)).toEqual(
      ['rows', 'search', 'profile'],
    );
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

  it('既知の総行数があれば page window 後に zstd 入力を閉じる', async () => {
    const totalRows = 10_000;
    const records = Array.from({ length: totalRows }, (_, index) => ({
      kind: 'record',
      row: [index, randomBytes(64).toString('hex')],
    }));
    const payload = [
      JSON.stringify({ kind: 'columns', columns: COLUMNS }),
      ...records.map((record) => JSON.stringify(record)),
      '',
    ].join('\n');
    const compressed = zstdCompressSync(payload);
    const chunkSize = 1024;
    const chunks = Array.from({ length: Math.ceil(compressed.length / chunkSize) }, (_, index) =>
      compressed.subarray(index * chunkSize, (index + 1) * chunkSize),
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

  it.each([
    ['missing', null],
    ['malformed JSON', 'not-json'],
    ['schema-invalid JSON', '[{"name":1}]'],
  ])('rejects a persisted result when history columns are %s', async (_label, columns) => {
    const store = new MemoryResultStore();
    const ctx = await createTestContext({ scenarios: [manyRows(4)], resultStore: store });
    const queryId = await submitPersistQuery(ctx);
    await waitForResultRef(ctx, queryId);
    await ctx.db.run('UPDATE query_history SET result_columns_json = $1 WHERE id = $2', [
      columns,
      queryId,
    ]);
    const getStream = vi.spyOn(store, 'getStream');
    dropExecution(ctx, queryId);

    const response = await ctx.app.request(`/api/queries/${queryId}`);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'PERSISTED_RESULT_METADATA_INVALID' },
    });
    expect(getStream).not.toHaveBeenCalled();
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
  it('rejects result reads with an explicit disabled error', async () => {
    const store = new NoneResultStore();

    await expect(store.getStream('result.jsonl.zst')).rejects.toThrow(
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
    const sendOptions: unknown[] = [];
    const destroy = vi.fn();
    let responseBody: Readable | undefined;
    const fakeClient = {
      destroy,
      send: async (command: object, options?: unknown) => {
        commands.push(command.constructor.name);
        sendOptions.push(options);
        if (command.constructor.name === 'GetObjectCommand') {
          responseBody = Readable.from(Buffer.from('body'));
          return { Body: responseBody };
        }
        return {};
      },
    };
    const uploaded: Array<{
      bucket: string;
      key: string;
      body: Readable;
      contentType: string;
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
              contentType: params.contentType,
              contentEncoding: params.contentEncoding,
            });
          },
        }),
      },
    );

    await store.put('prefix/q.jsonl.zst', Readable.from(Buffer.from('x')));
    const controller = new AbortController();
    await store.getStream('prefix/q.jsonl.zst', controller.signal);
    controller.abort();
    await store.delete('prefix/q.jsonl.zst');
    await store.close();

    expect(uploaded).toEqual([
      expect.objectContaining({
        bucket: 'bucket',
        key: 'prefix/q.jsonl.zst',
        contentType: 'application/x-ndjson',
        contentEncoding: 'zstd',
      }),
    ]);
    expect(commands).toEqual(['GetObjectCommand', 'DeleteObjectCommand']);
    expect(sendOptions[0]).toEqual({ abortSignal: controller.signal });
    expect(responseBody?.destroyed).toBe(true);
    expect(destroy).not.toHaveBeenCalled();
  });

  it('records get success before a later body abort and request failures', async () => {
    const successEvents: ResultStoreMetric[] = [];
    const responseBody = Readable.from(Buffer.from('body'));
    const controller = new AbortController();
    const successStore = new S3ResultStore(
      { bucket: 'bucket', region: 'us-east-1' },
      {
        client: {
          send: async () => ({ Body: responseBody }),
        } as never,
        observer: (event) => successEvents.push(event),
        clock: () => 1,
      },
    );

    await successStore.getStream('result', controller.signal);
    controller.abort();
    expect(successEvents).toContainEqual(
      expect.objectContaining({ kind: 's3-request', operation: 'get', outcome: 'success' }),
    );

    const failureEvents: ResultStoreMetric[] = [];
    const failureStore = new S3ResultStore(
      { bucket: 'bucket', region: 'us-east-1' },
      {
        client: {
          send: async () => {
            throw new Error('get failed');
          },
        } as never,
        observer: (event) => failureEvents.push(event),
        clock: () => 1,
      },
    );
    await expect(failureStore.getStream('result')).rejects.toThrow('get failed');
    expect(failureEvents).toContainEqual(
      expect.objectContaining({ kind: 's3-request', operation: 'get', outcome: 'failure' }),
    );
  });

  it('期限切れ object の空入力では bulk delete request を送らない', async () => {
    const send = vi.fn();
    const store = new S3ResultStore(
      { bucket: 'bucket', region: 'us-east-1' },
      { client: { send } as never },
    );

    await expect(store.deleteExpired([])).resolves.toEqual({ deleted: [], failed: [] });
    expect(send).not.toHaveBeenCalled();
  });

  it('bulk delete は 1000 key ごとに分割する', async () => {
    const requests: Array<{ name: string; keys: string[] }> = [];
    const fakeClient = {
      destroy: vi.fn(),
      send: async (command: object) => {
        const input = command as {
          constructor: { name: string };
          input: { Delete?: { Objects?: Array<{ Key?: string }> } };
        };
        const keys = (input.input.Delete?.Objects ?? []).flatMap((entry) =>
          entry.Key === undefined ? [] : [entry.Key],
        );
        requests.push({ name: input.constructor.name, keys });
        return { Deleted: keys.map((Key) => ({ Key })) };
      },
    };
    const store = new S3ResultStore(
      { bucket: 'bucket', region: 'us-east-1' },
      { client: fakeClient as never },
    );

    const input = Array.from({ length: 1_001 }, (_, index) => ({ key: `result-${index}` }));
    const result = await store.deleteExpired(input);

    expect(result.failed).toEqual([]);
    expect(result.deleted).toEqual(input.map((object) => object.key));
    expect(requests).toEqual([
      { name: 'DeleteObjectsCommand', keys: input.slice(0, 1_000).map((o) => o.key) },
      { name: 'DeleteObjectsCommand', keys: ['result-1000'] },
    ]);
  });

  it('bulk delete は partial error を key ごとの結果へ対応付ける', async () => {
    const send = vi.fn(async () => ({
      Deleted: [{ Key: 'ok' }],
      Errors: [{ Key: 'denied', Code: 'AccessDenied', Message: 'denied by policy' }],
    }));
    const events: ResultStoreMetric[] = [];
    const store = new S3ResultStore(
      { bucket: 'bucket', region: 'us-east-1' },
      {
        client: { send } as never,
        observer: (event) => events.push(event),
        clock: () => 1,
      },
    );

    const result = await store.deleteExpired([
      { key: 'ok' },
      { key: 'denied' },
      { key: 'missing' },
    ]);

    expect(result.deleted).toEqual(['ok']);
    expect(result.failed).toHaveLength(2);
    expect(result.failed[0]).toMatchObject({ key: 'denied', error: new Error('denied by policy') });
    expect(result.failed[1]).toMatchObject({
      key: 'missing',
      error: new Error('S3 bulk delete response omitted key: missing'),
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 's3-request',
        operation: 'delete',
        outcome: 'success',
        batchSize: 3,
        failedItems: 2,
      }),
    );
  });

  it('bulk delete は Deleted/Errors に無い key を failed にする', async () => {
    const send = vi.fn(async () => ({}));
    const store = new S3ResultStore(
      { bucket: 'bucket', region: 'us-east-1' },
      { client: { send } as never },
    );

    const result = await store.deleteExpired([{ key: 'missing-a' }, { key: 'missing-b' }]);

    expect(result.deleted).toEqual([]);
    expect(result.failed.map(({ key }) => key)).toEqual(['missing-a', 'missing-b']);
    expect(result.failed[0]?.error).toEqual(
      new Error('S3 bulk delete response omitted key: missing-a'),
    );
  });

  it('bulk delete request failure は batch 全 key を failed にする', async () => {
    const requestError = new Error('S3 unavailable');
    const send = vi.fn(async () => {
      throw requestError;
    });
    const store = new S3ResultStore(
      { bucket: 'bucket', region: 'us-east-1' },
      { client: { send } as never },
    );

    const result = await store.deleteExpired([{ key: 'failed-a' }, { key: 'failed-b' }]);

    expect(result.deleted).toEqual([]);
    expect(result.failed).toEqual([
      { key: 'failed-a', error: requestError },
      { key: 'failed-b', error: requestError },
    ]);
  });

  it('bulk delete は入力 key を重複除去して一意な結果を返す', async () => {
    const send = vi.fn(async (command: object) => {
      const input = command as { input: { Delete?: { Objects?: Array<{ Key?: string }> } } };
      const keys = (input.input.Delete?.Objects ?? []).flatMap((entry) =>
        entry.Key === undefined ? [] : [entry.Key],
      );
      return { Deleted: keys.map((Key) => ({ Key })) };
    });
    const store = new S3ResultStore(
      { bucket: 'bucket', region: 'us-east-1' },
      { client: { send } as never },
    );

    const result = await store.deleteExpired([{ key: 'same' }, { key: 'same' }, { key: 'other' }]);

    expect(result).toEqual({ deleted: ['same', 'other'], failed: [] });
    expect(send).toHaveBeenCalledOnce();
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
