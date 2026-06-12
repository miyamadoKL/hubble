import { describe, it, expect } from 'vitest';
import {
  notebookSchema,
  notebookListItemSchema,
  savedQuerySchema,
  historyResponseSchema,
} from '@hue-fable/contracts';
import { createTestContext } from '../test/harness';
import type { FakeScenario } from '../test/fakeTrino';

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
    const ctx = createTestContext();
    const created = await json(
      await ctx.app.request('/api/notebooks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Analysis', description: 'sales' }),
      }),
      notebookSchema,
    );
    expect(created.id).toMatch(/^nb_/);
    expect(created.cells).toEqual([]);

    const list = await json(
      await ctx.app.request('/api/notebooks'),
      arrayOf(notebookListItemSchema),
    );
    expect(list).toHaveLength(1);

    const got = await json(await ctx.app.request(`/api/notebooks/${created.id}`), notebookSchema);
    expect(got.name).toBe('Analysis');

    const updated = await json(
      await ctx.app.request(`/api/notebooks/${created.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Renamed',
          description: 'updated',
          cells: [{ id: 'c1', kind: 'sql', source: 'SELECT 1' }],
          variables: [],
          context: { catalog: 'tpch' },
        }),
      }),
      notebookSchema,
    );
    expect(updated.name).toBe('Renamed');
    expect(updated.cells).toHaveLength(1);
    expect(updated.context.catalog).toBe('tpch');

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
  });

  it('rejects invalid create bodies with a 400 envelope', async () => {
    const ctx = createTestContext();
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
    const ctx = createTestContext();
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
      savedQuerySchema,
    );

    const list = await json(await ctx.app.request('/api/saved-queries'), arrayOf(savedQuerySchema));
    expect(list[0]!.id).toBe(fav.id); // favorite first

    const search = await json(
      await ctx.app.request('/api/saved-queries?query=SELECT%202'),
      arrayOf(savedQuerySchema),
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
      savedQuerySchema,
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
    const ctx = createTestContext({ scenarios: [nationScenario] });
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
    const ctx = createTestContext({
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
