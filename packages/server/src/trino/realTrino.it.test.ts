import { describe, it, expect } from 'vitest';
import { openMemoryDatabase } from '../db';
import { loadServerConfig } from '../config';
import { buildServices } from '../services';
import { createApp } from '../app';
import type { EstimateResult, QuerySnapshot } from '@hubble/contracts';

/**
 * Integration tests against a real Trino. Skipped unless RUN_TRINO_IT=1.
 * Targets the local dev Trino (http://127.0.0.1:30080, admin / empty password).
 */
const RUN = process.env.RUN_TRINO_IT === '1';
const describeIt = RUN ? describe : describe.skip;

async function makeApp(env: Record<string, string | undefined> = {}) {
  const config = loadServerConfig({ ...process.env, ...env });
  const db = await openMemoryDatabase();
  const services = await buildServices(config, db);
  return { app: createApp({ services }), services };
}

async function runQuery(
  app: Awaited<ReturnType<typeof makeApp>>['app'],
  services: Awaited<ReturnType<typeof makeApp>>['services'],
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
    const { app, services } = await makeApp();
    const snap = await runQuery(app, services, { statement: 'SELECT 1' });
    expect(snap.state).toBe('finished');
    expect(snap.rowCount).toBe(1);
    const rows = await (await app.request(`/api/queries/${snap.queryId}/rows`)).json();
    expect((rows as { rows: unknown[][] }).rows[0]).toEqual([1]);
  });

  it('SHOW CATALOGS includes tpch', async () => {
    const { app, services } = await makeApp();
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
    const { app, services } = await makeApp();
    const snap = await runQuery(app, services, {
      statement: 'SELECT * FROM nation',
      catalog: 'tpch',
      schema: 'tiny',
    });
    expect(snap.state).toBe('finished');
    expect(snap.rowCount).toBe(25);
  });

  it('syntax error reports line/column', async () => {
    const { app, services } = await makeApp();
    const snap = await runQuery(app, services, { statement: 'SELECT FROM x WHERE' });
    expect(snap.state).toBe('failed');
    expect(snap.error?.trinoErrorName).toBe('SYNTAX_ERROR');
    expect(snap.error?.line).toBe(1);
    expect(typeof snap.error?.column).toBe('number');
  });

  it('cancel a running query', async () => {
    const { app, services } = await makeApp();
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
    const { app, services } = await makeApp();
    const res = await app.request(`/api/datasources/${services.defaultDatasourceId}/catalogs`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { name: string }[]; source: string };
    expect(body.items.map((c) => c.name)).toContain('tpch');
  });

  it('Query Guard estimate: lineitem full scan reports scanRows and blocks', async () => {
    const { app } = await makeApp({
      QUERY_GUARD_MODE: 'enforce',
      QUERY_GUARD_MAX_SCAN_ROWS: '1000000',
    });
    const res = await app.request('/api/queries/estimate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        statement: 'SELECT * FROM tpch.sf1.lineitem',
        catalog: 'tpch',
        schema: 'sf1',
      }),
    });
    expect(res.status).toBe(200);
    const result = (await res.json()) as EstimateResult;
    expect(result.status).toBe('estimated');
    expect(result.scanRows).toBeGreaterThan(6_000_000);
    expect(result.scanBytes ?? 0).toBeGreaterThan(0);
    expect(result.verdict.decision).toBe('block');
  });

  it('Query Guard estimate: a small table is allowed', async () => {
    const { app } = await makeApp({
      QUERY_GUARD_MODE: 'enforce',
      QUERY_GUARD_MAX_SCAN_ROWS: '1000000',
    });
    const res = await app.request('/api/queries/estimate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        statement: 'SELECT * FROM tpch.tiny.nation',
        catalog: 'tpch',
        schema: 'tiny',
      }),
    });
    const result = (await res.json()) as EstimateResult;
    expect(result.status).toBe('estimated');
    expect(result.scanRows).toBe(25);
    expect(result.verdict.decision).toBe('allow');
  });

  it('Query Guard estimate: stats-less table is unknown', async () => {
    const { app } = await makeApp({
      QUERY_GUARD_MODE: 'warn',
      QUERY_GUARD_MAX_SCAN_ROWS: '10',
    });
    const res = await app.request('/api/queries/estimate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ statement: 'SELECT * FROM system.runtime.queries' }),
    });
    const result = (await res.json()) as EstimateResult;
    expect(result.status).toBe('estimated');
    expect(result.scanRows).toBeNull();
    expect(result.scanBytes).toBeNull();
  });

  it('Query Guard enforce: a large run is blocked with QUERY_BLOCKED', async () => {
    const { app } = await makeApp({
      QUERY_GUARD_MODE: 'enforce',
      QUERY_GUARD_MAX_SCAN_ROWS: '1000000',
    });
    const res = await app.request('/api/queries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        statement: 'SELECT * FROM tpch.sf1.lineitem',
        catalog: 'tpch',
        schema: 'sf1',
      }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('QUERY_BLOCKED');
  });

  it('EXPLAIN VALIDATE: a valid statement passes', async () => {
    const { services } = await makeApp();
    const engine = services.engines.get(services.defaultDatasourceId)!;
    const result = await engine.validate({
      statement: 'SELECT count(*) FROM tpch.tiny.nation',
      principal: 'admin',
    });
    expect(result.ok).toBe(true);
  });

  it('EXPLAIN VALIDATE: a syntax error is a USER_ERROR with line/column', async () => {
    const { services } = await makeApp();
    const engine = services.engines.get(services.defaultDatasourceId)!;
    const result = await engine.validate({
      statement: 'SELECT FROM x WHERE',
      principal: 'admin',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('user_error');
      if (result.kind === 'user_error') {
        expect(result.line).toBe(1);
        expect(typeof result.column).toBe('number');
      }
    }
  });

  it('schedule create rejects a syntactically invalid statement (400 VALIDATION)', async () => {
    const { app } = await makeApp();
    const res = await app.request('/api/schedules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'bad',
        statement: 'SELECT FROM x WHERE',
        cron: '* * * * *',
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('manual run executes against Trino, recording success + row_count + query id', async () => {
    const { app, services } = await makeApp({ SCHEDULER_ENABLED: 'false' });
    await services.scheduler.start();
    await services.workflowRunner.start();
    const createRes = await app.request('/api/schedules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'nation count',
        statement: 'SELECT count(*) FROM tpch.tiny.nation',
        cron: '* * * * *',
      }),
    });
    expect(createRes.status).toBe(201);
    const { id } = (await createRes.json()) as { id: string };

    const runRes = await app.request(`/api/schedules/${id}/run`, { method: 'POST' });
    expect(runRes.status).toBe(202);
    await services.scheduler.whenIdle();

    const runsRes = await app.request(`/api/schedules/${id}/runs`);
    const { items } = (await runsRes.json()) as {
      items: Array<{ status: string; rowCount: number | null; trinoQueryId: string | null }>;
    };
    expect(items).toHaveLength(1);
    expect(items[0]!.status).toBe('success');
    expect(items[0]!.rowCount).toBe(1);
    expect(items[0]!.trinoQueryId).toBeTruthy();
    await services.shutdown();
  });

  it('CSV download streams the full result even when the buffer is truncated', async () => {
    // Server buffers only 100 rows, but tpch.tiny.orders has 15000. The download
    // must re-run the statement and emit every row (C-2), not the preview cap.
    const { app, services } = await makeApp({ QUERY_MAX_ROWS: '100' });
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
