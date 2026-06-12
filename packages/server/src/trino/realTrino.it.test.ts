import { describe, it, expect } from 'vitest';
import { openDatabase } from '../db';
import { loadServerConfig } from '../config';
import { buildServices } from '../services';
import { createApp } from '../app';
import type { QuerySnapshot } from '@hue-fable/contracts';

/**
 * Integration tests against a real Trino. Skipped unless RUN_TRINO_IT=1.
 * Targets the local dev Trino (http://127.0.0.1:30080, admin / empty password).
 */
const RUN = process.env.RUN_TRINO_IT === '1';
const describeIt = RUN ? describe : describe.skip;

function makeApp(env: Record<string, string | undefined> = {}) {
  const config = loadServerConfig({ ...process.env, ...env });
  const db = openDatabase(':memory:');
  const services = buildServices(config, db);
  return { app: createApp({ services }), services };
}

async function runQuery(
  app: ReturnType<typeof makeApp>['app'],
  services: ReturnType<typeof makeApp>['services'],
  body: Record<string, unknown>,
): Promise<QuerySnapshot> {
  const res = await app.request('/api/queries', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(202);
  const { queryId } = (await res.json()) as { queryId: string };
  await services.registry.get(queryId)!.settled;
  const snapRes = await app.request(`/api/queries/${queryId}`);
  return (await snapRes.json()) as QuerySnapshot;
}

describeIt('real Trino integration', () => {
  it('SELECT 1', async () => {
    const { app, services } = makeApp();
    const snap = await runQuery(app, services, { statement: 'SELECT 1' });
    expect(snap.state).toBe('finished');
    expect(snap.rowCount).toBe(1);
    const rows = await (await app.request(`/api/queries/${snap.queryId}/rows`)).json();
    expect((rows as { rows: unknown[][] }).rows[0]).toEqual([1]);
  });

  it('SHOW CATALOGS includes tpch', async () => {
    const { app, services } = makeApp();
    const snap = await runQuery(app, services, { statement: 'SHOW CATALOGS' });
    expect(snap.state).toBe('finished');
    const rows = (
      (await (await app.request(`/api/queries/${snap.queryId}/rows?limit=100`)).json()) as {
        rows: string[][];
      }
    ).rows;
    expect(rows.flat()).toContain('tpch');
  });

  it('tpch.tiny.nation has 25 rows', async () => {
    const { app, services } = makeApp();
    const snap = await runQuery(app, services, {
      statement: 'SELECT * FROM nation',
      catalog: 'tpch',
      schema: 'tiny',
    });
    expect(snap.state).toBe('finished');
    expect(snap.rowCount).toBe(25);
  });

  it('syntax error reports line/column', async () => {
    const { app, services } = makeApp();
    const snap = await runQuery(app, services, { statement: 'SELECT FROM x WHERE' });
    expect(snap.state).toBe('failed');
    expect(snap.error?.trinoErrorName).toBe('SYNTAX_ERROR');
    expect(snap.error?.line).toBe(1);
    expect(typeof snap.error?.column).toBe('number');
  });

  it('cancel a running query', async () => {
    const { app, services } = makeApp();
    // A query large enough to stay running across at least one poll.
    const res = await app.request('/api/queries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        statement: 'SELECT count(*) FROM tpch.sf1.lineitem',
      }),
    });
    const { queryId } = (await res.json()) as { queryId: string };
    // Give it a brief moment to start, then cancel.
    await new Promise((r) => setTimeout(r, 150));
    await app.request(`/api/queries/${queryId}`, { method: 'DELETE' });
    await services.registry.get(queryId)!.settled;
    const state = services.registry.get(queryId)!.state;
    expect(['canceled', 'finished']).toContain(state);
  });

  it('metadata: catalogs endpoint returns live data', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/catalogs');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { name: string }[]; source: string };
    expect(body.items.map((c) => c.name)).toContain('tpch');
  });

  it('CSV download streams the full result even when the buffer is truncated', async () => {
    // Server buffers only 100 rows, but tpch.tiny.orders has 15000. The download
    // must re-run the statement and emit every row (C-2), not the preview cap.
    const { app, services } = makeApp({ QUERY_MAX_ROWS: '100' });
    const res = await app.request('/api/queries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        statement: 'SELECT orderkey, custkey FROM tpch.tiny.orders ORDER BY orderkey',
        maxRows: 100,
      }),
    });
    const { queryId } = (await res.json()) as { queryId: string };
    const exec = services.registry.get(queryId)!;
    await exec.settled;
    expect(exec.truncated).toBe(true);
    expect(exec.bufferedCount).toBe(100);

    const csvRes = await app.request(`/api/queries/${queryId}/download.csv`);
    const text = await csvRes.text();
    const lines = text.split('\r\n').filter((l) => l !== '');
    expect(lines[0]).toBe('orderkey,custkey');
    expect(lines.length).toBe(15001); // header + 15000 rows
  }, 60_000);
});
