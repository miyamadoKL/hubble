import { describe, it, expect } from 'vitest';
import {
  notebookResponseSchema,
  notebookListItemSchema,
  savedQueryResponseSchema,
  historyResponseSchema,
  listDocumentSharesResponseSchema,
} from '@hubble/contracts';
import { createTestContext } from '../test/harness';
import type { FakeScenario } from '../test/fakeTrino';

function proxyCtx() {
  return createTestContext({
    env: { AUTH_MODE: 'proxy' },
    remoteAddress: () => '127.0.0.1',
  });
}

const ssoHeaders = (email: string) => ({ 'x-forwarded-email': email });

interface Parser<T> {
  parse(value: unknown): T;
}

async function json<T>(res: Response, schema: Parser<T>): Promise<T> {
  return schema.parse(await res.json());
}

/** Array-of-schema parser without a direct zod import. */
function arrayOf<T>(schema: Parser<T>): Parser<T[]> {
  return { parse: (value) => (value as unknown[]).map((v) => schema.parse(v)) };
}

describe('notebook CRUD', () => {
  it('creates, lists, gets, updates, searches, and deletes', async () => {
    const ctx = await createTestContext();
    const created = await json(
      await ctx.app.request('/api/notebooks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Analysis', description: 'sales' }),
      }),
      notebookResponseSchema,
    );
    expect(created.id).toMatch(/^nb_/);
    expect(created.cells).toEqual([]);
    expect(created.revision).toBe(1);

    const list = await json(
      await ctx.app.request('/api/notebooks'),
      arrayOf(notebookListItemSchema),
    );
    expect(list).toHaveLength(1);

    const got = await json(
      await ctx.app.request(`/api/notebooks/${created.id}`),
      notebookResponseSchema,
    );
    expect(got.name).toBe('Analysis');

    const updated = await json(
      await ctx.app.request(`/api/notebooks/${created.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          revision: created.revision,
          name: 'Renamed',
          description: 'updated',
          cells: [{ id: 'c1', kind: 'sql', source: 'SELECT 1' }],
          variables: [],
          context: { catalog: 'tpch' },
        }),
      }),
      notebookResponseSchema,
    );
    expect(updated.name).toBe('Renamed');
    expect(updated.cells).toHaveLength(1);
    expect(updated.context.catalog).toBe('tpch');
    expect(updated.revision).toBe(2);

    const stale = await ctx.app.request(`/api/notebooks/${created.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        revision: created.revision,
        name: 'Stale overwrite',
        description: 'stale',
        cells: [],
        variables: [],
        context: {},
      }),
    });
    expect(stale.status).toBe(409);
    expect((await stale.json()) as unknown).toMatchObject({
      error: { code: 'NOTEBOOK_REVISION_CONFLICT' },
    });
    expect(
      await json(await ctx.app.request(`/api/notebooks/${created.id}`), notebookResponseSchema),
    ).toMatchObject({ name: 'Renamed', revision: 2 });

    const search = await json(
      await ctx.app.request('/api/notebooks?query=Renam'),
      arrayOf(notebookListItemSchema),
    );
    expect(search).toHaveLength(1);
    const noMatch = await json(
      await ctx.app.request('/api/notebooks?query=zzz'),
      arrayOf(notebookListItemSchema),
    );
    expect(noMatch).toHaveLength(0);

    const del = await ctx.app.request(`/api/notebooks/${created.id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    const after = await ctx.app.request(`/api/notebooks/${created.id}`);
    expect(after.status).toBe(404);
    const updateMissing = await ctx.app.request(`/api/notebooks/${created.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        revision: updated.revision,
        name: 'Missing',
        description: '',
        cells: [],
        variables: [],
        context: {},
      }),
    });
    expect(updateMissing.status).toBe(404);
  });

  it('rejects invalid create bodies with a 400 envelope', async () => {
    const ctx = await createTestContext();
    const res = await ctx.app.request('/api/notebooks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'no name' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('saved-query CRUD', () => {
  it('creates, favorites-first ordering, search, update, delete', async () => {
    const ctx = await createTestContext();
    await ctx.app.request('/api/saved-queries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'plain', statement: 'SELECT 1' }),
    });
    const fav = await json(
      await ctx.app.request('/api/saved-queries', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'favorite', statement: 'SELECT 2', isFavorite: true }),
      }),
      savedQueryResponseSchema,
    );

    const list = await json(
      await ctx.app.request('/api/saved-queries'),
      arrayOf(savedQueryResponseSchema),
    );
    expect(list[0]!.id).toBe(fav.id); // favorite first

    const search = await json(
      await ctx.app.request('/api/saved-queries?query=SELECT%202'),
      arrayOf(savedQueryResponseSchema),
    );
    expect(search).toHaveLength(1);

    const updated = await json(
      await ctx.app.request(`/api/saved-queries/${fav.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'favorite',
          description: 'd',
          statement: 'SELECT 3',
          isFavorite: false,
        }),
      }),
      savedQueryResponseSchema,
    );
    expect(updated.statement).toBe('SELECT 3');
    expect(updated.isFavorite).toBe(false);

    const del = await ctx.app.request(`/api/saved-queries/${fav.id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
  });
});

const nationScenario: FakeScenario = {
  match: 'nation',
  trinoId: 'nation',
  pages: [
    {
      columns: [{ name: 'n', type: 'bigint' }],
      data: [[1], [2], [3]],
      state: 'FINISHED',
    },
  ],
};

describe('history auto-record', () => {
  it('records on submit and updates state/rowCount/elapsed on settle', async () => {
    const ctx = await createTestContext({ scenarios: [nationScenario] });
    const res = await ctx.app.request('/api/queries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ statement: 'SELECT * FROM nation', catalog: 'tpch', schema: 'tiny' }),
    });
    const { queryId } = (await res.json()) as { queryId: string };
    await ctx.services.registry.get(queryId)!.settled;
    // Allow the settled.then() history update microtask to flush.
    await new Promise((r) => setTimeout(r, 0));

    const history = await json(await ctx.app.request('/api/history'), historyResponseSchema);
    expect(history.total).toBe(1);
    const entry = history.items[0]!;
    expect(entry.id).toBe(queryId);
    expect(entry.state).toBe('finished');
    expect(entry.rowCount).toBe(3);
    expect(entry.catalog).toBe('tpch');
    expect(entry.schema).toBe('tiny');
    expect(entry.trinoQueryId).toMatch(/^nation_/);
  });

  it('filters by state and paginates', async () => {
    const ctx = await createTestContext({
      scenarios: [
        nationScenario,
        {
          match: 'bad',
          error: { message: 'line 1:1: boom', errorName: 'SYNTAX_ERROR' },
        },
      ],
    });
    const ids: string[] = [];
    for (const stmt of ['SELECT * FROM nation', 'SELECT bad']) {
      const res = await ctx.app.request('/api/queries', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ statement: stmt }),
      });
      ids.push(((await res.json()) as { queryId: string }).queryId);
    }
    await Promise.all(ids.map((id) => ctx.services.registry.get(id)!.settled));
    await new Promise((r) => setTimeout(r, 0));

    const failed = await json(
      await ctx.app.request('/api/history?state=failed'),
      historyResponseSchema,
    );
    expect(failed.total).toBe(1);
    expect(failed.items[0]!.state).toBe('failed');
    expect(failed.items[0]!.errorMessage).toContain('boom');

    const page = await json(
      await ctx.app.request('/api/history?offset=0&limit=1'),
      historyResponseSchema,
    );
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(2);
  });
});

describe('document sharing', () => {
  const alice = ssoHeaders('alice@corp.com');
  const bob = ssoHeaders('bob@corp.com');
  const carol = ssoHeaders('carol@corp.com');

  it('saved-query shares: owner-only GET/PUT, duplicate 400, audit on PUT', async () => {
    const ctx = await proxyCtx();
    const created = await json(
      await ctx.app.request('/api/saved-queries', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...alice },
        body: JSON.stringify({ name: 'shared', statement: 'SELECT 1' }),
      }),
      savedQueryResponseSchema,
    );

    const bobGetShares = await ctx.app.request(`/api/saved-queries/${created.id}/shares`, {
      headers: bob,
    });
    expect(bobGetShares.status).toBe(404);

    const bobPutShares = await ctx.app.request(`/api/saved-queries/${created.id}/shares`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...bob },
      body: JSON.stringify({
        shares: [{ subjectType: 'user', subjectValue: 'bob', permission: 'view' }],
      }),
    });
    expect(bobPutShares.status).toBe(404);

    const dup = await ctx.app.request(`/api/saved-queries/${created.id}/shares`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...alice },
      body: JSON.stringify({
        shares: [
          { subjectType: 'user', subjectValue: 'bob', permission: 'view' },
          { subjectType: 'user', subjectValue: 'bob', permission: 'edit' },
        ],
      }),
    });
    expect(dup.status).toBe(400);

    const shares = await json(
      await ctx.app.request(`/api/saved-queries/${created.id}/shares`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...alice },
        body: JSON.stringify({
          shares: [{ subjectType: 'user', subjectValue: 'bob', permission: 'edit' }],
        }),
      }),
      listDocumentSharesResponseSchema,
    );
    expect(shares.shares).toHaveLength(1);
    expect(shares.shares[0]!.permission).toBe('edit');

    const bobSharesForbidden = await ctx.app.request(`/api/saved-queries/${created.id}/shares`, {
      headers: bob,
    });
    expect(bobSharesForbidden.status).toBe(403);

    const auditRows = await ctx.services.audit.listForTest();
    const shareAudit = auditRows.find((row) => row.action === 'document.share.update');
    expect(shareAudit).toMatchObject({
      actor: 'alice',
      target: `saved_query:${created.id}`,
    });
    expect(shareAudit?.detail).toMatchObject({ count: 1 });
  });

  it('shared saved query: list/get/update for edit; view-only PUT is 403', async () => {
    const ctx = await proxyCtx();
    const created = await json(
      await ctx.app.request('/api/saved-queries', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...alice },
        body: JSON.stringify({ name: 'mine', statement: 'SELECT 1', isFavorite: true }),
      }),
      savedQueryResponseSchema,
    );

    await json(
      await ctx.app.request(`/api/saved-queries/${created.id}/shares`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...alice },
        body: JSON.stringify({
          shares: [{ subjectType: 'user', subjectValue: 'bob', permission: 'view' }],
        }),
      }),
      listDocumentSharesResponseSchema,
    );

    const bobList = await json(
      await ctx.app.request('/api/saved-queries', { headers: bob }),
      arrayOf(savedQueryResponseSchema),
    );
    expect(bobList).toHaveLength(1);
    expect(bobList[0]).toMatchObject({ owner: 'alice', myPermission: 'view' });

    const bobGet = await json(
      await ctx.app.request(`/api/saved-queries/${created.id}`, { headers: bob }),
      savedQueryResponseSchema,
    );
    expect(bobGet.myPermission).toBe('view');

    const viewPut = await ctx.app.request(`/api/saved-queries/${created.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...bob },
      body: JSON.stringify({
        name: 'mine',
        description: '',
        statement: 'SELECT 9',
        isFavorite: false,
      }),
    });
    expect(viewPut.status).toBe(403);

    await json(
      await ctx.app.request(`/api/saved-queries/${created.id}/shares`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...alice },
        body: JSON.stringify({
          shares: [{ subjectType: 'user', subjectValue: 'bob', permission: 'edit' }],
        }),
      }),
      listDocumentSharesResponseSchema,
    );

    const bobUpdated = await json(
      await ctx.app.request(`/api/saved-queries/${created.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...bob },
        body: JSON.stringify({
          name: 'mine',
          description: '',
          statement: 'SELECT 9',
          isFavorite: false,
        }),
      }),
      savedQueryResponseSchema,
    );
    expect(bobUpdated.statement).toBe('SELECT 9');
    expect(bobUpdated.isFavorite).toBe(true);

    const carolGet = await ctx.app.request(`/api/saved-queries/${created.id}`, { headers: carol });
    expect(carolGet.status).toBe(404);

    const bobDelete = await ctx.app.request(`/api/saved-queries/${created.id}`, {
      method: 'DELETE',
      headers: bob,
    });
    expect(bobDelete.status).toBe(403);
  });

  it('notebook shares: shared user can list and get; owner manages shares', async () => {
    const ctx = await proxyCtx();
    const created = await json(
      await ctx.app.request('/api/notebooks', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...alice },
        body: JSON.stringify({ name: 'Team nb' }),
      }),
      notebookResponseSchema,
    );

    await json(
      await ctx.app.request(`/api/notebooks/${created.id}/shares`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...alice },
        body: JSON.stringify({
          shares: [{ subjectType: 'user', subjectValue: 'bob', permission: 'view' }],
        }),
      }),
      listDocumentSharesResponseSchema,
    );

    const bobList = await json(
      await ctx.app.request('/api/notebooks', { headers: bob }),
      arrayOf(notebookListItemSchema),
    );
    expect(bobList).toHaveLength(1);
    expect(bobList[0]).toMatchObject({ owner: 'alice', myPermission: 'view' });

    const bobUpdate = await ctx.app.request(`/api/notebooks/${created.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...bob },
      body: JSON.stringify({
        revision: created.revision,
        name: 'Denied',
        description: '',
        cells: [],
        variables: [],
        context: {},
      }),
    });
    expect(bobUpdate.status).toBe(403);

    const ownerShares = await json(
      await ctx.app.request(`/api/notebooks/${created.id}/shares`, { headers: alice }),
      listDocumentSharesResponseSchema,
    );
    expect(ownerShares.shares[0]!.subjectValue).toBe('bob');
  });
});
