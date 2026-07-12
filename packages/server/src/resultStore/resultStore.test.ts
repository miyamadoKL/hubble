import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { S3Client } from '@aws-sdk/client-s3';
import type { QueryRowsPage, QuerySnapshot } from '@hubble/contracts';
import { createTestContext } from '../test/harness';
import type { FakeScenario } from '../test/fakeTrino';
import type { DeleteExpiredResult, ExpiredResultObject, ResultStore } from './store';
import { readPersistedRowsPage, ResultJsonlCapture } from './jsonl';
import { S3ResultStore, buildS3ClientConfig } from './s3';
import type { HistoryResultRef } from '../store/history';

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

  it('streams all rows to fake ResultStore and records the history object key', async () => {
    const store = new MemoryResultStore();
    const ctx = await createTestContext({
      scenarios: [manyRows(20)],
      resultStore: store,
      configOverrides: { query: { maxRows: 5 } as never },
    });

    const queryId = await submitPersistQuery(ctx);
    const ref = await waitForResultRef(ctx, queryId);
    expect(ref.resultObjectKey).toBe(`hubble-results/${queryId}.jsonl.gz`);
    expect(new Date(ref.resultExpiresAt).getTime()).toBeGreaterThan(Date.now());

    const page = await readPersistedRowsPage(await store.getStream(ref.resultObjectKey), 18, 5);
    expect(page.columns).toEqual(COLUMNS);
    expect(page.totalRows).toBe(20);
    expect(page.rows).toEqual([
      [18, 'note_18'],
      [19, 'note_19'],
    ]);
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
    dropExecution(ctx, queryId);

    const snapRes = await ctx.app.request(`/api/queries/${queryId}`);
    expect(snapRes.status).toBe(200);
    const snap = (await snapRes.json()) as QuerySnapshot;
    expect(snap.columns).toEqual(COLUMNS);
    expect(snap.rowCount).toBe(12);
    expect(snap.datasourceId).toBe('trino-default');

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
    const uploaded: Array<{ bucket: string; key: string; body: Readable }> = [];
    const store = new S3ResultStore(
      { bucket: 'bucket', region: 'us-east-1' },
      {
        client: fakeClient as never,
        uploadFactory: (params) => ({
          done: async () => {
            uploaded.push({ bucket: params.bucket, key: params.key, body: params.body });
          },
        }),
      },
    );

    await store.put('prefix/q.jsonl.gz', Readable.from(Buffer.from('x')));
    await store.getStream('prefix/q.jsonl.gz');
    await store.delete('prefix/q.jsonl.gz');
    await store.close();

    expect(uploaded[0]).toMatchObject({ bucket: 'bucket', key: 'prefix/q.jsonl.gz' });
    expect(commands).toEqual(['GetObjectCommand', 'DeleteObjectCommand']);
    expect(destroy).not.toHaveBeenCalled();
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
