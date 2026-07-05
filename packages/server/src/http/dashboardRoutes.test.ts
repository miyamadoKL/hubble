/**
 * dashboardRoutes.ts の統合テスト。
 */
import { describe, expect, it } from 'vitest';
import {
  dashboardListItemSchema,
  dashboardSchema,
  listDocumentSharesResponseSchema,
} from '@hubble/contracts';
import { createTestContext } from '../test/harness';

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

function arrayOf<T>(schema: Parser<T>): Parser<T[]> {
  return { parse: (value) => (value as unknown[]).map((v) => schema.parse(v)) };
}

describe('dashboard routes', () => {
  it('creates, lists, gets, updates, searches, and deletes', async () => {
    const ctx = await createTestContext();
    const created = await json(
      await ctx.app.request('/api/dashboards', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Sales board', description: 'q3 metrics' }),
      }),
      dashboardSchema,
    );
    expect(created.id).toMatch(/^dsh_/);
    expect(created.widgets).toEqual([]);

    const list = await json(
      await ctx.app.request('/api/dashboards'),
      arrayOf(dashboardListItemSchema),
    );
    expect(list).toHaveLength(1);
    expect(list[0]!.widgetCount).toBe(0);

    const got = await json(await ctx.app.request(`/api/dashboards/${created.id}`), dashboardSchema);
    expect(got.name).toBe('Sales board');

    const updated = await json(
      await ctx.app.request(`/api/dashboards/${created.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Renamed board',
          description: 'updated',
          widgets: [
            {
              id: 'w1',
              kind: 'text',
              position: { col: 0, row: 0, sizeX: 4, sizeY: 2 },
              text: 'Hello',
            },
          ],
        }),
      }),
      dashboardSchema,
    );
    expect(updated.name).toBe('Renamed board');
    expect(updated.widgets).toHaveLength(1);

    const searchHit = await json(
      await ctx.app.request('/api/dashboards?query=Renam'),
      arrayOf(dashboardListItemSchema),
    );
    expect(searchHit).toHaveLength(1);
    expect(searchHit[0]!.widgetCount).toBe(1);

    const del = await ctx.app.request(`/api/dashboards/${created.id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect((await ctx.app.request(`/api/dashboards/${created.id}`)).status).toBe(404);
  });

  it('dashboard shares: shared user can list and get; owner manages shares', async () => {
    const ctx = await proxyCtx();
    const alice = ssoHeaders('alice@corp.com');
    const bob = ssoHeaders('bob@corp.com');

    const created = await json(
      await ctx.app.request('/api/dashboards', {
        method: 'POST',
        headers: { ...alice, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Shared dash', description: 'd' }),
      }),
      dashboardSchema,
    );

    await json(
      await ctx.app.request(`/api/dashboards/${created.id}/shares`, {
        method: 'PUT',
        headers: { ...alice, 'content-type': 'application/json' },
        body: JSON.stringify({
          shares: [{ subjectType: 'user', subjectValue: 'bob', permission: 'view' }],
        }),
      }),
      listDocumentSharesResponseSchema,
    );

    const bobList = await json(
      await ctx.app.request('/api/dashboards', { headers: bob }),
      arrayOf(dashboardListItemSchema),
    );
    expect(bobList).toHaveLength(1);
    expect(bobList[0]!.myPermission).toBe('view');

    const bobPutForbidden = await ctx.app.request(`/api/dashboards/${created.id}/shares`, {
      method: 'PUT',
      headers: { ...bob, 'content-type': 'application/json' },
      body: JSON.stringify({
        shares: [{ subjectType: 'user', subjectValue: 'bob', permission: 'edit' }],
      }),
    });
    expect(bobPutForbidden.status).toBe(403);

    const ownerShares = await json(
      await ctx.app.request(`/api/dashboards/${created.id}/shares`, { headers: alice }),
      listDocumentSharesResponseSchema,
    );
    expect(ownerShares.shares[0]!.subjectValue).toBe('bob');
  });
});
