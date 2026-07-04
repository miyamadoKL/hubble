import { test, expect, request as playwrightRequest } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { AUTH_SERVER_URL } from '../playwright.config';

/**
 * Proxy-mode auth, verified at the API level against a dedicated
 * `AUTH_MODE=proxy` BFF (separate port, see playwright.config.ts). No real
 * oauth2-proxy is involved: the spec injects `x-forwarded-email` itself, and
 * because requests originate from localhost (inside the default trusted CIDR)
 * the server honors them. Browser UI in `none` mode is covered by the default
 * suite; here we exercise the server's auth + owner-scoping contract.
 *
 * The default none-mode browser suite is unaffected.
 */

const TINY = { catalog: 'tpch', schema: 'tiny' };

/** An API context bound to the auth server, optionally with an SSO identity. */
async function ctxFor(email?: string): Promise<APIRequestContext> {
  return playwrightRequest.newContext({
    baseURL: AUTH_SERVER_URL,
    extraHTTPHeaders: email ? { 'x-forwarded-email': email } : {},
  });
}

async function runToHistory(api: APIRequestContext, statement: string): Promise<string> {
  const res = await api.post('/api/queries', {
    data: { statement, ...TINY, source: 'hubble' },
  });
  expect(res.status()).toBe(202);
  const { queryId } = await res.json();
  for (let i = 0; i < 120; i++) {
    const snap = await api.get(`/api/queries/${queryId}`).then((r) => r.json());
    if (['finished', 'failed', 'canceled'].includes(snap.state)) return queryId;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('query did not settle');
}

test.describe('proxy-mode auth (API)', () => {
  test('(a) /api/me returns the resolved principal for a trusted SSO header', async () => {
    const api = await ctxFor('alice@example.com');
    const res = await api.get('/api/me');
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({
      user: 'alice',
      email: 'alice@example.com',
      authMode: 'proxy',
    });
    await api.dispose();
  });

  test('(b) /api/me returns 401 UNAUTHENTICATED without SSO headers', async () => {
    const api = await ctxFor();
    const res = await api.get('/api/me');
    expect(res.status()).toBe(401);
    expect((await res.json()).error.code).toBe('UNAUTHENTICATED');

    // A protected resource is equally gated.
    expect((await api.get('/api/notebooks')).status()).toBe(401);

    // healthz stays public.
    expect((await api.get('/api/healthz')).status()).toBe(200);
    await api.dispose();
  });

  test('(c) query execution records history under the principal, isolated per user', async () => {
    const alice = await ctxFor('alice@example.com');
    const bob = await ctxFor('bob@example.com');

    await runToHistory(alice, 'SELECT 1 AS auth_alice');
    await runToHistory(bob, 'SELECT 2 AS auth_bob');

    const aliceHist = await alice.get('/api/history').then((r) => r.json());
    const bobHist = await bob.get('/api/history').then((r) => r.json());

    // Each user only sees their own statement.
    const aliceStatements = aliceHist.items.map((i: { statement: string }) => i.statement);
    const bobStatements = bobHist.items.map((i: { statement: string }) => i.statement);
    expect(aliceStatements.some((s: string) => s.includes('auth_alice'))).toBe(true);
    expect(aliceStatements.some((s: string) => s.includes('auth_bob'))).toBe(false);
    expect(bobStatements.some((s: string) => s.includes('auth_bob'))).toBe(true);
    expect(bobStatements.some((s: string) => s.includes('auth_alice'))).toBe(false);

    await alice.dispose();
    await bob.dispose();
  });
});
