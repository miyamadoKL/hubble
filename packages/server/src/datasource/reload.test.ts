import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ResolvedMysqlDatasource } from './types';
import { applyDatasourceReloadSync, planDatasourceReload } from './reload';
import { createMysqlEngine } from '../engine/mysql/engine';
import { TEST_TRINO_CONFIG } from '../test/testEngine';
import type { QueryEngine } from '../engine/types';
import { createTestContext } from '../test/harness';

const mysqlDs = (id: string, host: string): ResolvedMysqlDatasource => ({
  id,
  type: 'mysql',
  displayName: id,
  username: 'u',
  password: 'p',
  host,
  port: 3306,
  database: 'db',
  readOnly: true,
  tls: false,
  maxConnections: 5,
});

describe('planDatasourceReload', () => {
  it('reuses engine when config unchanged', () => {
    const poolFactory = () => ({ end: vi.fn(), query: vi.fn() }) as never;
    const ds = mysqlDs('mysql-1', 'db.local');
    const engine = createMysqlEngine({ datasource: ds, poolFactory });
    const engines = new Map<string, QueryEngine>([['mysql-1', engine]]);
    const plan = planDatasourceReload(engines, [ds], [ds], {
      trinoConfig: TEST_TRINO_CONFIG,
      mysqlPoolFactory: poolFactory,
    });
    expect(plan.enginesToSet.size).toBe(0);
    expect(engines.get('mysql-1')).toBe(engine);
  });
});

describe('services.reloadDatasources', () => {
  let tempDir: string;
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'hubble-reload-'));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('keeps current config on invalid YAML', async () => {
    writeFileSync(
      join(tempDir, 'datasources.yaml'),
      `datasources:
  - id: trino-a
    type: trino
    username: admin
    baseUrl: http://trino.test
`,
      'utf8',
    );
    const errors: unknown[] = [];
    const ctx = await createTestContext({
      env: { DATASOURCES_PATH: 'datasources.yaml' },
      cwd: tempDir,
      reloadLogError: (_m, e) => errors.push(e),
    });
    writeFileSync(join(tempDir, 'datasources.yaml'), 'datasources: [{bad', 'utf8');
    await ctx.services.reloadDatasources();
    expect(errors).toHaveLength(1);
    expect(ctx.services.datasources[0]!.id).toBe('trino-a');
  });

  it('swaps datasources on valid reload', async () => {
    writeFileSync(
      join(tempDir, 'datasources.yaml'),
      `datasources:
  - id: trino-a
    type: trino
    username: admin
    baseUrl: http://trino.test
`,
      'utf8',
    );
    const ctx = await createTestContext({
      env: { DATASOURCES_PATH: 'datasources.yaml' },
      cwd: tempDir,
    });
    writeFileSync(
      join(tempDir, 'datasources.yaml'),
      `datasources:
  - id: trino-b
    type: trino
    username: admin
    baseUrl: http://trino.test
`,
      'utf8',
    );
    await ctx.services.reloadDatasources();
    expect(ctx.services.datasources[0]!.id).toBe('trino-b');
    expect(ctx.services.engines.has('trino-a')).toBe(false);
  });
});

describe('services.reloadDatasources in-flight queries', () => {
  let tempDir: string;
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'hubble-reload-flight-'));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('lets an in-flight query finish after reload swaps datasources', async () => {
    writeFileSync(
      join(tempDir, 'datasources.yaml'),
      `datasources:
  - id: trino-a
    type: trino
    username: admin
    baseUrl: http://trino.test
`,
      'utf8',
    );
    const slowPages = [
      ...Array.from({ length: 8 }, () => ({ state: 'RUNNING' as const })),
      {
        columns: [{ name: 'n', type: 'bigint' }],
        data: [[1]],
        state: 'FINISHED' as const,
      },
    ];
    const ctx = await createTestContext({
      env: { DATASOURCES_PATH: 'datasources.yaml' },
      cwd: tempDir,
      scenarios: [{ match: 'slow', trinoId: 'slow', pages: slowPages }],
    });
    const submitRes = await ctx.app.request('/api/queries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ statement: 'SELECT slow' }),
    });
    expect(submitRes.status).toBe(202);
    const { queryId } = (await submitRes.json()) as { queryId: string };

    writeFileSync(
      join(tempDir, 'datasources.yaml'),
      `datasources:
  - id: trino-b
    type: trino
    username: admin
    baseUrl: http://trino.test
`,
      'utf8',
    );
    await ctx.services.reloadDatasources();

    const exec = ctx.services.registry.get(queryId);
    await exec!.settled;
    expect(exec!.state).toBe('finished');
    expect(ctx.services.datasources[0]!.id).toBe('trino-b');
    await ctx.services.shutdown();
  });

  it('applies valid config after a failed reload', async () => {
    writeFileSync(
      join(tempDir, 'datasources.yaml'),
      `datasources:
  - id: trino-a
    type: trino
    username: admin
    baseUrl: http://trino.test
`,
      'utf8',
    );
    const ctx = await createTestContext({
      env: { DATASOURCES_PATH: 'datasources.yaml' },
      cwd: tempDir,
    });
    writeFileSync(join(tempDir, 'datasources.yaml'), 'not: [yaml', 'utf8');
    await ctx.services.reloadDatasources();
    expect(ctx.services.datasources[0]!.id).toBe('trino-a');

    writeFileSync(
      join(tempDir, 'datasources.yaml'),
      `datasources:
  - id: trino-c
    type: trino
    username: admin
    baseUrl: http://trino.test
`,
      'utf8',
    );
    await ctx.services.reloadDatasources();
    expect(ctx.services.datasources[0]!.id).toBe('trino-c');
    await ctx.services.shutdown();
  });

  it('returns 404 when submitting to a removed datasource', async () => {
    writeFileSync(
      join(tempDir, 'datasources.yaml'),
      `datasources:
  - id: trino-a
    type: trino
    username: admin
    baseUrl: http://trino.test
`,
      'utf8',
    );
    const ctx = await createTestContext({
      env: { DATASOURCES_PATH: 'datasources.yaml' },
      cwd: tempDir,
    });
    writeFileSync(
      join(tempDir, 'datasources.yaml'),
      `datasources:
  - id: trino-b
    type: trino
    username: admin
    baseUrl: http://trino.test
`,
      'utf8',
    );
    await ctx.services.reloadDatasources();

    const res = await ctx.app.request('/api/queries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ statement: 'SELECT 1', datasourceId: 'trino-a' }),
    });
    expect(res.status).toBe(404);
    await ctx.services.shutdown();
  });
});

describe('applyDatasourceReloadSync', () => {
  it('calls pool.end on replaced engines', async () => {
    const poolEnd = vi.fn(async () => {});
    const poolFactory = () => ({ end: poolEnd, query: vi.fn() }) as never;
    const before = mysqlDs('mysql-1', 'old');
    const after = mysqlDs('mysql-1', 'new');
    const engine = createMysqlEngine({ datasource: before, poolFactory });
    const engines = new Map([['mysql-1', engine]]);
    const datasources = [before];
    const plan = planDatasourceReload(engines, datasources, [after], {
      trinoConfig: TEST_TRINO_CONFIG,
      mysqlPoolFactory: poolFactory,
    });
    applyDatasourceReloadSync(
      {
        engines,
        datasources,
        setDefaultDatasourceId: () => {},
        invalidateDatasource: () => {},
      },
      plan,
    );
    await Promise.resolve();
    expect(poolEnd).toHaveBeenCalledTimes(1);
  });

  it('closes role credential pools on replaced engines', async () => {
    const poolEnd = vi.fn(async () => {});
    const poolFactory = () => ({ end: poolEnd, query: vi.fn(), on: vi.fn() }) as never;
    const before: ResolvedMysqlDatasource = {
      ...mysqlDs('mysql-1', 'old'),
      roleCredentials: {
        analyst: { username: 'analyst', password: 'secret' },
      },
    };
    const after = mysqlDs('mysql-1', 'new');
    const engine = createMysqlEngine({ datasource: before, poolFactory });
    engine.executionClient({ source: 'user', roleName: 'analyst' });
    const engines = new Map([['mysql-1', engine]]);
    const datasources = [before];
    const plan = planDatasourceReload(engines, datasources, [after], {
      trinoConfig: TEST_TRINO_CONFIG,
      mysqlPoolFactory: poolFactory,
    });
    applyDatasourceReloadSync(
      {
        engines,
        datasources,
        setDefaultDatasourceId: () => {},
        invalidateDatasource: () => {},
      },
      plan,
    );
    await Promise.resolve();
    expect(poolEnd).toHaveBeenCalledTimes(2);
  });
});
