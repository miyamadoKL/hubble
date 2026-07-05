import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { createTestContext, waitForTerminal } from '../test/harness';
import type { FakeScenario } from '../test/fakeTrino';
import type { ResultStore } from '../resultStore';
import { DocumentGitLinkRepository } from '../github/store';
import { contentHash, savedQueryToContent } from '../github/canonical';

const GITHUB_KEY = Buffer.alloc(32, 6);

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
    });
    const savedDoc = (await ctx.services.savedQueries.get(accessor, saved.id))!;
    const links = new DocumentGitLinkRepository(ctx.db);
    await links.upsert('saved_query', saved.id, {
      path: `saved-queries/${saved.id}.sql`,
      approvedHash: contentHash(savedQueryToContent(savedDoc)),
    });
    expect(await ctx.services.githubGovernance.isStatementApproved('SELECT approved')).toBe(true);
    const queryId = await submit(ctx, { statement: 'SELECT approved' });
    await waitForTerminal(ctx.services, queryId);
    await vi.waitFor(() => {
      expect(store.objects.size).toBeGreaterThan(0);
    });
    const auditRows = await ctx.services.audit.listForTest();
    expect(auditRows.some((row) => row.action === 'query.result.persist')).toBe(true);
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
