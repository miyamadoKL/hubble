/**
 * 結果探索 API（rows/search, profile）の結合テスト。
 */
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { ResultProfile, ResultSearchPage } from '@hubble/contracts';
import { apiRoutes } from '@hubble/contracts';
import { createTestContext, waitForTerminal } from '../test/harness';
import type { FakeScenario } from '../test/fakeTrino';
import {
  memoryResultStoreValidator,
  memoryResultStoreVersionId,
  readMemoryResultRange,
  validateMemoryResultRequest,
} from '../test/memoryResultStore';
import type {
  DeleteExpiredResult,
  ExpiredResultObject,
  ResultArtifactFormat,
  ResultStore,
} from '../resultStore/store';
import type { ResultStoreRequestOptions } from '../resultStore/store';

const NATION_COLUMNS = [
  { name: 'nationkey', type: 'bigint' },
  { name: 'name', type: 'varchar' },
];

function nationScenario(rowCount: number): FakeScenario {
  const rows = Array.from({ length: rowCount }, (_, i) => [i, `nation_${i}`]);
  return {
    match: 'nation',
    trinoId: 'nation',
    pages: [
      { columns: NATION_COLUMNS, data: rows.slice(0, Math.ceil(rowCount / 2)), state: 'RUNNING' },
      { data: rows.slice(Math.ceil(rowCount / 2)), state: 'FINISHED' },
    ],
  };
}

async function submit(
  app: Awaited<ReturnType<typeof createTestContext>>['app'],
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<string> {
  const res = await app.request('/api/queries', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(202);
  const { queryId } = (await res.json()) as { queryId: string };
  return queryId;
}

function proxyCtx(scenarios: FakeScenario[] = []) {
  return createTestContext({
    env: { AUTH_MODE: 'proxy' },
    remoteAddress: () => '127.0.0.1',
    scenarios,
  });
}

const alice = { 'x-forwarded-email': 'alice@corp.com' };
const bob = { 'x-forwarded-email': 'bob@corp.com' };

/** インメモリの ResultStore フェイク（resultStore.test.ts と同じ流儀）。 */
class MemoryResultStore implements ResultStore {
  readonly enabled = true;
  readonly objects = new Map<string, Buffer>();

  async put(key: string, body: Readable, _format: ResultArtifactFormat): Promise<void> {
    void _format;
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

/** 永続化結果の history 記録を待つ（resultStore.test.ts と同じ流儀）。 */
async function waitForResultRef(
  ctx: Awaited<ReturnType<typeof createTestContext>>,
  queryId: string,
  owner = 'admin',
): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const ref = await ctx.services.history.getResultRef(owner, queryId);
    if (ref) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('result ref was not recorded');
}

/** registry からメモリ上の実行を消し、永続化フォールバック経路を強制する。 */
function dropExecution(ctx: Awaited<ReturnType<typeof createTestContext>>, queryId: string): void {
  const registry = ctx.services.registry as unknown as {
    executions: Map<string, unknown>;
  };
  registry.executions.delete(queryId);
}

describe('POST /api/queries/:id/rows/search', () => {
  it('filters and pages in-memory buffered rows', async () => {
    const ctx = await createTestContext({ scenarios: [nationScenario(25)] });
    const queryId = await submit(ctx.app, { statement: 'SELECT * FROM nation', catalog: 'tpch' });
    await waitForTerminal(ctx.services, queryId);

    const res = await ctx.app.request(apiRoutes.queryRowsSearch(queryId), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        search: 'nation_1',
        offset: 0,
        limit: 5,
      }),
    });
    expect(res.status).toBe(200);
    const page = (await res.json()) as ResultSearchPage;
    expect(page.totalRows).toBe(25);
    expect(page.complete).toBe(true);
    expect(page.totalMatched).toBe(11); // nation_1, nation_10..19
    expect(page.rows.length).toBeLessThanOrEqual(5);
    expect(page.rows.every((row) => String(row[1]).includes('nation_1'))).toBe(true);
  });

  it("returns 404 when another user searches A's query", async () => {
    const ctx = await proxyCtx([
      { match: 'SELECT', pages: [{ columns: NATION_COLUMNS, data: [[0, 'a']] }] },
    ]);
    const queryId = await submit(ctx.app, { statement: 'SELECT 1' }, alice);
    await waitForTerminal(ctx.services, queryId);

    const res = await ctx.app.request(apiRoutes.queryRowsSearch(queryId), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bob },
      body: JSON.stringify({ offset: 0, limit: 10 }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 400 VALIDATION_ERROR when offset + limit exceeds the search window cap', async () => {
    const ctx = await createTestContext({ scenarios: [nationScenario(3)] });
    const queryId = await submit(ctx.app, { statement: 'SELECT * FROM nation', catalog: 'tpch' });
    await waitForTerminal(ctx.services, queryId);

    const res = await ctx.app.request(apiRoutes.queryRowsSearch(queryId), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // offset + limit = 100,001 > 100,000（RESULT_SEARCH_MAX_WINDOW）。
      body: JSON.stringify({ offset: 100_000, limit: 1 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 VALIDATION_ERROR when columnIndex is out of range', async () => {
    const ctx = await createTestContext({ scenarios: [nationScenario(3)] });
    const queryId = await submit(ctx.app, { statement: 'SELECT * FROM nation', catalog: 'tpch' });
    await waitForTerminal(ctx.services, queryId);

    const res = await ctx.app.request(apiRoutes.queryRowsSearch(queryId), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        filters: [{ columnIndex: 99, op: 'eq', value: 'x' }],
        offset: 0,
        limit: 10,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('persisted result exploration (rows beyond QUERY_MAX_ROWS)', () => {
  // maxRows=3 でメモリバッファは 3 行に打ち切られるが、永続化結果は全 12 行を含む。
  // メモリ上の実行を消して永続化フォールバック経路を検証する。
  function persistScenario(rowCount: number): FakeScenario {
    return {
      match: 'persist',
      trinoId: 'persist',
      pages: Array.from({ length: rowCount }, (_, i) => ({
        columns: i === 0 ? NATION_COLUMNS : undefined,
        data: [[i, `nation_${i}`]],
        state: i === rowCount - 1 ? 'FINISHED' : 'RUNNING',
      })),
    };
  }

  async function persistedCtx(): Promise<{
    ctx: Awaited<ReturnType<typeof createTestContext>>;
    queryId: string;
    store: MemoryResultStore;
  }> {
    const store = new MemoryResultStore();
    const ctx = await createTestContext({
      scenarios: [persistScenario(12)],
      resultStore: store,
      configOverrides: { query: { maxRows: 3 } as never },
    });
    const queryId = await submit(ctx.app, { statement: 'SELECT * FROM persist', maxRows: 3 });
    await waitForTerminal(ctx.services, queryId);
    await waitForResultRef(ctx, queryId);
    dropExecution(ctx, queryId);
    return { ctx, queryId, store };
  }

  it('searches all persisted rows, not just the in-memory truncation', async () => {
    const { ctx, queryId } = await persistedCtx();
    const res = await ctx.app.request(apiRoutes.queryRowsSearch(queryId), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        filters: [{ columnIndex: 0, op: 'gte', value: '10' }],
        sort: { columnIndex: 0, dir: 'desc' },
        offset: 0,
        limit: 10,
      }),
    });
    expect(res.status).toBe(200);
    const page = (await res.json()) as ResultSearchPage;
    // メモリ側は 3 行で打ち切りだが、永続化結果には 12 行すべてが残っている。
    expect(page.totalRows).toBe(12);
    expect(page.totalMatched).toBe(2);
    expect(page.complete).toBe(true);
    expect(page.rows).toEqual([
      [11, 'nation_11'],
      [10, 'nation_10'],
    ]);
  });

  it('profiles all persisted rows', async () => {
    const { ctx, queryId } = await persistedCtx();
    const res = await ctx.app.request(apiRoutes.queryProfile(queryId));
    expect(res.status).toBe(200);
    const profile = (await res.json()) as ResultProfile;
    expect(profile.rowCount).toBe(12);
    expect(profile.complete).toBe(true);
    expect(profile.columns[0]).toMatchObject({
      name: 'nationkey',
      nullCount: 0,
      distinctCount: 12,
      distinctOverflow: false,
    });
    expect(profile.columns[0]!.min).toBe('0');
    expect(profile.columns[0]!.max).toBe('11');
  });

  it('returns 304 for a matching persisted rows ETag without reading ResultStore', async () => {
    const { ctx, queryId, store } = await persistedCtx();
    const first = await ctx.app.request(apiRoutes.queryRows(queryId));
    const etag = first.headers.get('etag');
    expect(first.status).toBe(200);
    expect(etag).toMatch(/^W\/"/);

    const getStream = vi.spyOn(store, 'getStream');
    const revalidated = await ctx.app.request(apiRoutes.queryRows(queryId), {
      headers: { 'if-none-match': etag! },
    });

    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get('etag')).toBe(etag);
    expect(revalidated.headers.get('cache-control')).toBe('private, no-cache');
    expect(getStream).not.toHaveBeenCalled();
  });

  it('returns 304 for a matching persisted profile ETag without reading ResultStore', async () => {
    const { ctx, queryId, store } = await persistedCtx();
    const first = await ctx.app.request(apiRoutes.queryProfile(queryId));
    const etag = first.headers.get('etag');
    expect(first.status).toBe(200);
    expect(etag).toMatch(/^W\/"/);

    const getStream = vi.spyOn(store, 'getStream');
    const revalidated = await ctx.app.request(apiRoutes.queryProfile(queryId), {
      headers: { 'if-none-match': etag! },
    });

    expect(revalidated.status).toBe(304);
    expect(getStream).not.toHaveBeenCalled();
  });

  it('returns the normal body when the persisted rows ETag does not match', async () => {
    const { ctx, queryId, store } = await persistedCtx();
    const first = await ctx.app.request(apiRoutes.queryRows(queryId));
    expect(first.status).toBe(200);

    const getStream = vi.spyOn(store, 'getStream');
    const response = await ctx.app.request(apiRoutes.queryRows(queryId), {
      headers: { 'if-none-match': 'W/"different-result"' },
    });

    expect(response.status).toBe(200);
    expect(((await response.json()) as { totalBuffered: number }).totalBuffered).toBe(12);
    expect(getStream).toHaveBeenCalledOnce();
  });

  it('does not return 304 to a non-owner with a matching ETag', async () => {
    const store = new MemoryResultStore();
    const ctx = await createTestContext({
      env: { AUTH_MODE: 'proxy', AUTH_USER_MAPPING: 'user' },
      remoteAddress: () => '127.0.0.1',
      scenarios: [persistScenario(3)],
      resultStore: store,
    });
    const ownerHeaders = { ...alice, 'x-forwarded-user': 'alice' };
    const nonOwnerHeaders = { ...bob, 'x-forwarded-user': 'bob' };
    const queryId = await submit(
      ctx.app,
      { statement: 'SELECT * FROM persist', maxRows: 3 },
      ownerHeaders,
    );
    await waitForTerminal(ctx.services, queryId);
    await waitForResultRef(ctx, queryId, 'alice');
    dropExecution(ctx, queryId);

    const ownerResponse = await ctx.app.request(apiRoutes.queryRows(queryId), {
      headers: ownerHeaders,
    });
    const etag = ownerResponse.headers.get('etag');
    const nonOwnerResponse = await ctx.app.request(apiRoutes.queryRows(queryId), {
      headers: { ...nonOwnerHeaders, 'if-none-match': etag! },
    });

    expect(ownerResponse.status).toBe(200);
    expect(etag).toBeTruthy();
    expect(nonOwnerResponse.status).toBe(404);
  });

  it('does not return 304 for an expired persisted result', async () => {
    const { ctx, queryId } = await persistedCtx();
    const first = await ctx.app.request(apiRoutes.queryRows(queryId));
    const etag = first.headers.get('etag');
    await ctx.db.run('UPDATE query_history SET result_expires_at = ? WHERE id = ?', [
      '2000-01-01T00:00:00.000Z',
      queryId,
    ]);

    const response = await ctx.app.request(apiRoutes.queryRows(queryId), {
      headers: { 'if-none-match': etag! },
    });

    expect(response.status).toBe(404);
  });

  it('rejects out-of-range columnIndex against persisted columns', async () => {
    const { ctx, queryId } = await persistedCtx();
    const res = await ctx.app.request(apiRoutes.queryRowsSearch(queryId), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        filters: [{ columnIndex: 5, op: 'isNull' }],
        offset: 0,
        limit: 10,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/queries/:id/profile', () => {
  it('returns column profiles for buffered rows', async () => {
    const ctx = await createTestContext({ scenarios: [nationScenario(5)] });
    const queryId = await submit(ctx.app, { statement: 'SELECT * FROM nation', catalog: 'tpch' });
    await waitForTerminal(ctx.services, queryId);

    const res = await ctx.app.request(apiRoutes.queryProfile(queryId));
    expect(res.status).toBe(200);
    const profile = (await res.json()) as ResultProfile;
    expect(profile.rowCount).toBe(5);
    expect(profile.complete).toBe(true);
    expect(profile.columns).toHaveLength(2);
    expect(profile.columns[0]).toMatchObject({
      name: 'nationkey',
      type: 'bigint',
      nullCount: 0,
      distinctCount: 5,
      distinctOverflow: false,
    });
    expect(profile.columns[0]!.min).toBe('0');
    expect(profile.columns[0]!.max).toBe('4');
    expect(profile.columns[1]!.topValues.length).toBeGreaterThan(0);
  });
});
