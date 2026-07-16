/**
 * Phase 2: QueryEngine 抽象化とデータソースルーティングの統合テスト。
 */
import { describe, it, expect, beforeEach, afterEach, onTestFinished } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTestContext } from '../test/harness';
import type { FakeScenario } from '../test/fakeTrino';
import { deriveTrinoSourceTags } from './trino';
import { openTestDatabase } from '../test/dbBackends';
import { ScheduleRepository, ScheduleRunRepository } from '../store/schedules';
import { Scheduler } from '../schedule/scheduler';
import { JobAdmissionController } from '../schedule/admission';
import { EstimateService } from '../query/estimateService';
import { makeEnginesMap } from '../test/testEngine';
import { FakeTrino } from '../test/fakeTrino';
const fast: FakeScenario = {
  match: 'SELECT',
  pages: [{ columns: [{ name: 'n', type: 'bigint' }], data: [[1]], state: 'FINISHED' }],
};

const VALIDATE_OK: FakeScenario = {
  match: 'EXPLAIN (TYPE VALIDATE)',
  pages: [{ columns: [{ name: 'result', type: 'boolean' }], data: [[true]] }],
};

function writeDatasourcesYaml(dir: string, body: string): string {
  const path = join(dir, 'datasources.yaml');
  writeFileSync(path, body, 'utf8');
  return path;
}

describe('deriveTrinoSourceTags', () => {
  it('uses the datasource default source fields (hubble / hubble-metadata / hubble-scheduled)', () => {
    // `loadDatasources()` は source/metadataSource/scheduledSource が YAML に
    // 未指定の場合、既定値を埋めたうえで ResolvedTrinoDatasource を返す。
    // ここではその「既定値が埋まった状態」を模して検証する。
    const tags = deriveTrinoSourceTags({
      id: 'trino-a',
      type: 'trino',
      displayName: 'Trino',
      username: 'admin',
      password: '',
      baseUrl: 'http://trino.test',
      source: 'hubble',
      metadataSource: 'hubble-metadata',
      scheduledSource: 'hubble-scheduled',
    });
    expect(tags).toEqual({
      user: 'hubble',
      metadata: 'hubble-metadata',
      scheduled: 'hubble-scheduled',
      download: 'hubble-download',
    });
  });

  it('derives tags from explicit datasource source/metadataSource/scheduledSource fields', () => {
    const tags = deriveTrinoSourceTags({
      id: 'trino-prod',
      type: 'trino',
      displayName: 'Prod',
      username: 'admin',
      password: '',
      baseUrl: 'http://trino.test',
      source: 'custom-source',
      metadataSource: 'custom-metadata',
      scheduledSource: 'custom-scheduled',
    });
    expect(tags).toEqual({
      user: 'custom-source',
      metadata: 'custom-metadata',
      scheduled: 'custom-scheduled',
      download: 'custom-source-download',
    });
  });
});

describe('datasource routing (HTTP)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'hubble-ds-route-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('routes datasourceId to the matching engine and derives X-Trino-Source', async () => {
    const yamlPath = writeDatasourcesYaml(
      tempDir,
      `datasources:
  - id: trino-a
    type: trino
    username: admin
    baseUrl: http://trino.test
    source: source-a
  - id: trino-b
    type: trino
    username: admin
    baseUrl: http://trino.test
    source: source-b
`,
    );
    const ctx = await createTestContext({
      scenarios: [fast],
      env: { DATASOURCES_PATH: yamlPath },
      cwd: tempDir,
    });

    const resA = await ctx.app.request('/api/queries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ statement: 'SELECT 1', datasourceId: 'trino-a' }),
    });
    expect(resA.status).toBe(202);
    const { queryId: idA } = (await resA.json()) as { queryId: string };
    await ctx.services.registry.get(idA)!.settled;

    const resB = await ctx.app.request('/api/queries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ statement: 'SELECT 1', datasourceId: 'trino-b' }),
    });
    expect(resB.status).toBe(202);
    const { queryId: idB } = (await resB.json()) as { queryId: string };
    await ctx.services.registry.get(idB)!.settled;

    const sources = ctx.fake.requests
      .filter((r) => r.method === 'POST')
      .map((r) => r.headers['x-trino-source'] ?? r.headers['X-Trino-Source']);
    expect(sources).toContain('source-a');
    expect(sources).toContain('source-b');

    await ctx.services.shutdown();
  });

  it('uses the default datasource when datasourceId is omitted', async () => {
    const yamlPath = writeDatasourcesYaml(
      tempDir,
      `datasources:
  - id: first-ds
    type: trino
    username: admin
    baseUrl: http://trino.test
    source: first-source
  - id: second-ds
    type: trino
    username: admin
    baseUrl: http://trino.test
    source: second-source
`,
    );
    const ctx = await createTestContext({
      scenarios: [fast],
      env: { DATASOURCES_PATH: yamlPath },
      cwd: tempDir,
    });
    expect(ctx.services.defaultDatasourceId).toBe('first-ds');

    const res = await ctx.app.request('/api/queries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ statement: 'SELECT 1' }),
    });
    expect(res.status).toBe(202);
    const { queryId } = (await res.json()) as { queryId: string };
    await ctx.services.registry.get(queryId)!.settled;

    const snap = (await (await ctx.app.request(`/api/queries/${queryId}`)).json()) as {
      datasourceId: string;
    };
    expect(snap.datasourceId).toBe('first-ds');

    const source = ctx.fake.requests.find((r) => r.method === 'POST')?.headers['x-trino-source'];
    expect(source).toBe('first-source');

    await ctx.services.shutdown();
  });

  it('returns 404 for an unknown datasourceId', async () => {
    const ctx = await createTestContext({ scenarios: [fast] });
    const res = await ctx.app.request('/api/queries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ statement: 'SELECT 1', datasourceId: 'no-such-ds' }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
    await ctx.services.shutdown();
  });

  it('accepts mysql datasource queries under enforce guard without estimate', async () => {
    const yamlPath = writeDatasourcesYaml(
      tempDir,
      `datasources:
  - id: trino-default
    type: trino
    username: admin
    baseUrl: http://trino.test
    source: hubble
  - id: mysql-analytics
    type: mysql
    username: mysql-user
    host: 127.0.0.1
    port: 1
    database: analytics
`,
    );
    const ctx = await createTestContext({
      scenarios: [fast],
      env: { DATASOURCES_PATH: yamlPath },
      cwd: tempDir,
      configOverrides: {
        guard: {
          mode: 'enforce',
          maxScanBytes: 0,
          maxScanRows: 1,
          onUnknown: 'block',
          estimateTimeoutMs: 3000,
          cacheTtlSeconds: 0,
          bytesPerSecond: 0,
        } as never,
      },
    });

    const res = await ctx.app.request('/api/queries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ statement: 'SELECT 1', datasourceId: 'mysql-analytics' }),
    });
    // enforce でも costEstimate 非対応の mysql は見積りをスキップして受理される。
    expect(res.status).toBe(202);
    const { queryId } = (await res.json()) as { queryId: string };
    await ctx.services.registry.get(queryId)!.settled;

    const snapRes = await ctx.app.request(`/api/queries/${queryId}`);
    const snap = (await snapRes.json()) as { state: string; error?: { code: string } };
    expect(snap.state).toBe('failed');
    expect(snap.error?.code).not.toBe('QUERY_BLOCKED');

    await ctx.services.shutdown();
  });

  it('returns ESTIMATE_NOT_SUPPORTED for mysql datasource estimate', async () => {
    const yamlPath = writeDatasourcesYaml(
      tempDir,
      `datasources:
  - id: trino-default
    type: trino
    username: admin
    baseUrl: http://trino.test
    source: hubble
  - id: mysql-analytics
    type: mysql
    username: mysql-user
    host: mysql.internal
    database: analytics
`,
    );
    const ctx = await createTestContext({
      scenarios: [fast],
      env: { DATASOURCES_PATH: yamlPath },
      cwd: tempDir,
      configOverrides: { guard: { mode: 'warn' } as never },
    });

    const res = await ctx.app.request('/api/queries/estimate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ statement: 'SELECT 1', datasourceId: 'mysql-analytics' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('ESTIMATE_NOT_SUPPORTED');

    await ctx.services.shutdown();
  });
});

describe('schedule datasource persistence', () => {
  it('records failure when the persisted datasource is no longer configured', async () => {
    const db = await openTestDatabase();
    onTestFinished(() => db.close());
    const fake = new FakeTrino([VALIDATE_OK, fast]);
    const { engines, defaultDatasourceId } = makeEnginesMap(fake);
    const schedules = new ScheduleRepository(db);
    const runs = new ScheduleRunRepository(db, 50);
    const estimate = new EstimateService(engines, defaultDatasourceId, {
      mode: 'off',
      maxScanBytes: 0,
      maxScanRows: 0,
      onUnknown: 'allow',
      estimateTimeoutMs: 3000,
      cacheTtlSeconds: 0,
      bytesPerSecond: 0,
    });
    const { loadRbac } = await import('../rbac/loader');
    const scheduler = new Scheduler({
      schedules,
      runs,
      engines,
      defaultDatasourceId,
      estimate,
      getRbac: () => loadRbac({}),
      guardConfig: {
        mode: 'off',
        maxScanBytes: 0,
        maxScanRows: 0,
        onUnknown: 'allow',
        estimateTimeoutMs: 3000,
        cacheTtlSeconds: 0,
        bytesPerSecond: 0,
      },
      admission: new JobAdmissionController(2),
      config: {
        enabled: false,
        tickSeconds: 15,
        maxConcurrent: 2,
        runsRetention: 50,
        guardMode: 'off',
      },
      sleep: () => Promise.resolve(),
    });

    const schedule = await schedules.create('alice', {
      name: 'gone',
      statement: 'SELECT 1',
      cron: '* * * * *',
      datasourceId: 'removed-ds',

      principalSnapshot: { user: 'alice' },
    });

    const { runId } = await scheduler.runManual(schedule);
    await scheduler.whenIdle();

    const recorded = await runs.list(schedule.id, 10);
    expect(recorded[0]!.id).toBe(runId);
    expect(recorded[0]!.status).toBe('failed');
    expect(recorded[0]!.errorMessage).toContain("Datasource 'removed-ds' is not configured");
  });
});
