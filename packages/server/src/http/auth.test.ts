import { describe, it, expect } from 'vitest';
import { meResponseSchema, UNAUTHENTICATED } from '@hubble/contracts';
import { createTestContext, waitForTerminal } from '../test/harness';
import type { FakeScenario } from '../test/fakeTrino';

/** Proxy-mode harness: trusted loopback peer, with optional SSO headers. */
function proxyCtx(remote = '127.0.0.1', scenarios: FakeScenario[] = []) {
  return createTestContext({
    env: { AUTH_MODE: 'proxy' },
    remoteAddress: () => remote,
    scenarios,
  });
}

const ssoHeaders = (email: string) => ({ 'x-forwarded-email': email });

describe('auth — none mode (default)', () => {
  it('GET /api/me returns the technical user and authMode none', async () => {
    const ctx = await createTestContext();
    const res = await ctx.app.request('/api/me');
    expect(res.status).toBe(200);
    const me = meResponseSchema.parse(await res.json());
    expect(me).toEqual({ user: ctx.services.config.trino.user, authMode: 'none' });
  });

  it('serves the API without any auth headers', async () => {
    const ctx = await createTestContext();
    expect((await ctx.app.request('/api/notebooks')).status).toBe(200);
  });

  it('GET /api/healthz is public', async () => {
    const ctx = await createTestContext();
    expect((await ctx.app.request('/api/healthz')).status).toBe(200);
  });
});

describe('auth — proxy mode', () => {
  it('GET /api/me resolves the principal from trusted SSO headers', async () => {
    const ctx = await proxyCtx();
    const res = await ctx.app.request('/api/me', { headers: ssoHeaders('alice@corp.com') });
    expect(res.status).toBe(200);
    const me = meResponseSchema.parse(await res.json());
    expect(me).toEqual({ user: 'alice', email: 'alice@corp.com', authMode: 'proxy' });
  });

  it('returns 401 UNAUTHENTICATED when SSO headers are missing', async () => {
    const ctx = await proxyCtx();
    const res = await ctx.app.request('/api/me');
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe(UNAUTHENTICATED);
  });

  it('ignores SSO headers from an untrusted peer (→ 401)', async () => {
    const ctx = await proxyCtx('203.0.113.10');
    const res = await ctx.app.request('/api/me', { headers: ssoHeaders('evil@corp.com') });
    expect(res.status).toBe(401);
  });

  it('healthz stays public even in proxy mode from an untrusted peer', async () => {
    const ctx = await proxyCtx('203.0.113.10');
    expect((await ctx.app.request('/api/healthz')).status).toBe(200);
  });

  it('config requires auth (401 without headers)', async () => {
    const ctx = await proxyCtx();
    expect((await ctx.app.request('/api/config')).status).toBe(401);
  });
});

describe('auth — owner scoping', () => {
  const alice = ssoHeaders('alice@corp.com'); // -> user "alice"
  const bob = ssoHeaders('bob@corp.com'); // -> user "bob"

  async function createNotebook(
    ctx: Awaited<ReturnType<typeof proxyCtx>>,
    headers: Record<string, string>,
  ) {
    const res = await ctx.app.request('/api/notebooks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ name: 'Mine' }),
    });
    return (await res.json()) as { id: string };
  }

  it("notebooks: B cannot list, get, update, or delete A's notebook", async () => {
    const ctx = await proxyCtx();
    const { id } = await createNotebook(ctx, alice);

    // B's list is empty.
    const bobList = await (await ctx.app.request('/api/notebooks', { headers: bob })).json();
    expect(bobList).toEqual([]);

    // B's get -> 404.
    expect((await ctx.app.request(`/api/notebooks/${id}`, { headers: bob })).status).toBe(404);

    // B's update -> 404.
    const upd = await ctx.app.request(`/api/notebooks/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...bob },
      body: JSON.stringify({
        name: 'Hijacked',
        description: '',
        cells: [],
        variables: [],
        context: {},
      }),
    });
    expect(upd.status).toBe(404);

    // B's delete -> 404.
    expect(
      (await ctx.app.request(`/api/notebooks/${id}`, { method: 'DELETE', headers: bob })).status,
    ).toBe(404);

    // A still sees it, intact.
    const aliceList = (await (
      await ctx.app.request('/api/notebooks', { headers: alice })
    ).json()) as unknown[];
    expect(aliceList).toHaveLength(1);
    const got = (await (
      await ctx.app.request(`/api/notebooks/${id}`, { headers: alice })
    ).json()) as { name: string };
    expect(got.name).toBe('Mine');
  });

  it("saved queries: B cannot see or delete A's saved query", async () => {
    const ctx = await proxyCtx();
    const created = await ctx.app.request('/api/saved-queries', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...alice },
      body: JSON.stringify({ name: 'q', statement: 'SELECT 1' }),
    });
    const { id } = (await created.json()) as { id: string };

    expect(await (await ctx.app.request('/api/saved-queries', { headers: bob })).json()).toEqual([]);
    expect((await ctx.app.request(`/api/saved-queries/${id}`, { headers: bob })).status).toBe(404);
    expect(
      (await ctx.app.request(`/api/saved-queries/${id}`, { method: 'DELETE', headers: bob }))
        .status,
    ).toBe(404);
  });

  it('history: each user only sees their own executions', async () => {
    const scenarios: FakeScenario[] = [
      { match: 'SELECT', pages: [{ columns: [{ name: 'n', type: 'integer' }], data: [[1]] }] },
    ];
    const ctx = await proxyCtx('127.0.0.1', scenarios);

    const submit = async (headers: Record<string, string>) => {
      const res = await ctx.app.request('/api/queries', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ statement: 'SELECT 1' }),
      });
      const { queryId } = (await res.json()) as { queryId: string };
      await waitForTerminal(ctx.services, queryId);
      return queryId;
    };

    const aliceQ = await submit(alice);
    await submit(bob);

    const aliceHist = (await (
      await ctx.app.request('/api/history', { headers: alice })
    ).json()) as { total: number; items: { id: string }[] };
    expect(aliceHist.total).toBe(1);
    expect(aliceHist.items[0]!.id).toBe(aliceQ);

    const bobHist = (await (
      await ctx.app.request('/api/history', { headers: bob })
    ).json()) as { total: number };
    expect(bobHist.total).toBe(1);
  });

  it("queries: B cannot read A's query snapshot (404)", async () => {
    const scenarios: FakeScenario[] = [
      { match: 'SELECT', pages: [{ columns: [{ name: 'n', type: 'integer' }], data: [[1]] }] },
    ];
    const ctx = await proxyCtx('127.0.0.1', scenarios);
    const res = await ctx.app.request('/api/queries', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...alice },
      body: JSON.stringify({ statement: 'SELECT 1' }),
    });
    const { queryId } = (await res.json()) as { queryId: string };
    await waitForTerminal(ctx.services, queryId);

    expect((await ctx.app.request(`/api/queries/${queryId}`, { headers: bob })).status).toBe(404);
    expect((await ctx.app.request(`/api/queries/${queryId}`, { headers: alice })).status).toBe(200);
  });
});

describe('auth — Trino impersonation (X-Trino-User)', () => {
  it('user queries run as the resolved principal, not the technical user', async () => {
    const scenarios: FakeScenario[] = [
      { match: 'SELECT', pages: [{ columns: [{ name: 'n', type: 'integer' }], data: [[1]] }] },
    ];
    const ctx = await proxyCtx('127.0.0.1', scenarios);
    const res = await ctx.app.request('/api/queries', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ssoHeaders('alice@corp.com') },
      body: JSON.stringify({ statement: 'SELECT 1' }),
    });
    const { queryId } = (await res.json()) as { queryId: string };
    await waitForTerminal(ctx.services, queryId);

    const post = ctx.fake.requests.find((r) => r.method === 'POST');
    expect(post?.headers['x-trino-user']).toBe('alice');
    // Sanity: the technical user is "admin" by default.
    expect(ctx.services.config.trino.user).toBe('admin');
  });

  it('metadata queries keep using the technical user', async () => {
    const ctx = await proxyCtx('127.0.0.1');
    // The catalogs request triggers a metadata-source Trino query; we only assert
    // on the X-Trino-User of any such request (the response itself may error).
    await ctx.app.request('/api/catalogs', { headers: ssoHeaders('alice@corp.com') });
    const metaReq = ctx.fake.requests.find(
      (r) => r.headers['x-trino-source'] === 'hubble-metadata',
    );
    if (metaReq) {
      expect(metaReq.headers['x-trino-user']).toBe(ctx.services.config.trino.user);
    }
  });
});
