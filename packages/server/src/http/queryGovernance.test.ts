import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { createTestContext, waitForTerminal } from '../test/harness';
import type { FakeScenario } from '../test/fakeTrino';
import type { ResultStore } from '../resultStore';
import type { QueryEngine } from '../engine/types';
import { DocumentGitLinkRepository } from '../github/store';
import { contentHash, savedQueryToContent } from '../github/canonical';

const GITHUB_KEY = Buffer.alloc(32, 6);

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

class MemoryResultStore implements ResultStore {
  readonly enabled = true;
  readonly objects = new Map<string, Buffer>();

  async put(key: string, body: Readable): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    this.objects.set(key, Buffer.concat(chunks));
  }

  async getStream(key: string): Promise<Readable> {
    const data = this.objects.get(key);
    if (!data) throw new Error(`missing ${key}`);
    return Readable.from(data);
  }

  async delete(): Promise<void> {}

  async deleteExpired(objects: { key: string }[]) {
    for (const object of objects) this.objects.delete(object.key);
    return { deleted: objects.map((o) => o.key), failed: [] };
  }

  async close(): Promise<void> {}
}

const APPROVED_SCENARIO: FakeScenario = {
  match: 'SELECT approved',
  trinoId: 'approved',
  pages: [
    {
      columns: [{ name: 'n', type: 'bigint' }],
      data: [[1]],
      state: 'FINISHED',
    },
  ],
};

const UNAPPROVED_SCENARIO: FakeScenario = {
  match: 'SELECT unapproved',
  trinoId: 'unapproved',
  pages: [
    {
      columns: [{ name: 'n', type: 'bigint' }],
      data: [[2]],
      state: 'FINISHED',
    },
  ],
};

function githubConfigOverrides() {
  return {
    github: {
      enabled: true,
      repo: 'acme/hubble-docs',
      clientId: 'cid',
      clientSecret: 'sec',
      tokenEncryptionKey: GITHUB_KEY,
      defaultBranch: 'main',
      governance: 'on' as const,
      statusTtlSeconds: 120,
      syncCron: null,
    },
  };
}

describe('query governance persistence', () => {
  it('rejects submission when the engine changes during governance lookup', async () => {
    const ctx = await createTestContext({
      scenarios: [UNAPPROVED_SCENARIO],
      configOverrides: githubConfigOverrides(),
    });
    const approvalStarted = deferred<void>();
    const approval = deferred<boolean>();
    const submitSpy = vi.spyOn(ctx.services.queries, 'submit');
    vi.spyOn(ctx.services.githubGovernance, 'isStatementApproved').mockImplementation(async () => {
      approvalStarted.resolve(undefined);
      return approval.promise;
    });

    const response = ctx.app.request('/api/queries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ statement: 'SELECT unapproved' }),
    });
    await approvalStarted.promise;
    const datasourceId = ctx.services.defaultDatasourceId;
    const original = ctx.services.engines.get(datasourceId)!;
    ctx.services.engines.set(datasourceId, {} as QueryEngine);
    approval.resolve(false);
    const res = await response;
    ctx.services.engines.set(datasourceId, original);

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: 'DATASOURCE_RELOADING' },
    });
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it('rejects submission when the default datasource changes during governance lookup', async () => {
    const ctx = await createTestContext({
      scenarios: [UNAPPROVED_SCENARIO],
      configOverrides: githubConfigOverrides(),
    });
    const approvalStarted = deferred<void>();
    const approval = deferred<boolean>();
    const submitSpy = vi.spyOn(ctx.services.queries, 'submit');
    vi.spyOn(ctx.services.githubGovernance, 'isStatementApproved').mockImplementation(async () => {
      approvalStarted.resolve(undefined);
      return approval.promise;
    });

    const response = ctx.app.request('/api/queries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ statement: 'SELECT unapproved' }),
    });
    await approvalStarted.promise;
    const defaultDescriptor = Object.getOwnPropertyDescriptor(ctx.services, 'defaultDatasourceId')!;
    const replacementId = 'replacement-default';
    ctx.services.engines.set(replacementId, {} as QueryEngine);
    Object.defineProperty(ctx.services, 'defaultDatasourceId', {
      configurable: true,
      enumerable: true,
      value: replacementId,
    });
    approval.resolve(false);
    const res = await response;
    Object.defineProperty(ctx.services, 'defaultDatasourceId', defaultDescriptor);
    ctx.services.engines.delete(replacementId);

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: 'DATASOURCE_RELOADING' },
    });
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it('does not persist unapproved statements when governance is on', async () => {
    const store = new MemoryResultStore();
    const ctx = await createTestContext({
      scenarios: [UNAPPROVED_SCENARIO],
      resultStore: store,
      configOverrides: githubConfigOverrides(),
    });
    const queryId = await submit(ctx, { statement: 'SELECT unapproved' });
    await waitForTerminal(ctx.services, queryId);
    expect(store.objects.size).toBe(0);
    const auditRows = await ctx.services.audit.listForTest();
    expect(auditRows.some((row) => row.action === 'query.result.persist')).toBe(false);
  });

  it('persists approved statements when governance is on', async () => {
    const store = new MemoryResultStore();
    const ctx = await createTestContext({
      scenarios: [APPROVED_SCENARIO],
      resultStore: store,
      configOverrides: githubConfigOverrides(),
    });
    const accessor = { user: 'admin', groups: [] as string[], role: 'admin' };
    const saved = await ctx.services.savedQueries.create('admin', {
      name: 'Q',
      statement: 'SELECT approved',
      datasourceId: ctx.services.defaultDatasourceId,
      catalog: 'sales',
      schema: 'reporting',
    });
    const savedDoc = (await ctx.services.savedQueries.get(accessor, saved.id))!;
    const links = new DocumentGitLinkRepository(ctx.db);
    await links.upsert('saved_query', saved.id, {
      path: `saved-queries/${saved.id}.sql`,
      approvedHash: contentHash(savedQueryToContent(savedDoc)),
    });
    expect(
      await ctx.services.githubGovernance.isStatementApproved({
        datasourceId: ctx.services.defaultDatasourceId,
        catalog: 'sales',
        schema: 'reporting',
        statement: 'SELECT approved',
        defaultDatasourceId: ctx.services.defaultDatasourceId,
      }),
    ).toBe(true);
    const queryId = await submit(ctx, {
      statement: 'SELECT approved',
      datasourceId: ctx.services.defaultDatasourceId,
      catalog: 'sales',
      schema: 'reporting',
    });
    await waitForTerminal(ctx.services, queryId);
    await vi.waitFor(() => {
      expect(store.objects.size).toBeGreaterThan(0);
    });
    const auditRows = await ctx.services.audit.listForTest();
    expect(auditRows.some((row) => row.action === 'query.result.persist')).toBe(true);
  });

  it('does not persist an approved statement under a different catalog or schema', async () => {
    const store = new MemoryResultStore();
    const ctx = await createTestContext({
      scenarios: [APPROVED_SCENARIO],
      resultStore: store,
      configOverrides: githubConfigOverrides(),
    });
    const accessor = { user: 'admin', groups: [] as string[], role: 'admin' };
    const saved = await ctx.services.savedQueries.create('admin', {
      name: 'Scoped Q',
      statement: 'SELECT approved',
      datasourceId: ctx.services.defaultDatasourceId,
      catalog: 'sales',
      schema: 'reporting',
    });
    const savedDoc = (await ctx.services.savedQueries.get(accessor, saved.id))!;
    const links = new DocumentGitLinkRepository(ctx.db);
    await links.upsert('saved_query', saved.id, {
      path: `saved-queries/${saved.id}.sql`,
      approvedHash: contentHash(savedQueryToContent(savedDoc)),
    });

    const catalogMismatch = await submit(ctx, {
      statement: 'SELECT approved',
      datasourceId: ctx.services.defaultDatasourceId,
      catalog: 'finance',
      schema: 'reporting',
    });
    await waitForTerminal(ctx.services, catalogMismatch);
    const schemaMismatch = await submit(ctx, {
      statement: 'SELECT approved',
      datasourceId: ctx.services.defaultDatasourceId,
      catalog: 'sales',
      schema: 'private',
    });
    await waitForTerminal(ctx.services, schemaMismatch);

    expect(store.objects.size).toBe(0);
  });
});

async function submit(
  ctx: Awaited<ReturnType<typeof createTestContext>>,
  body: Record<string, unknown>,
): Promise<string> {
  const res = await ctx.app.request('/api/queries', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(202);
  const { queryId } = (await res.json()) as { queryId: string };
  return queryId;
}
