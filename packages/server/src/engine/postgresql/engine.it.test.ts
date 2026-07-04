/**
 * PostgreSQL エンジンの統合テスト(TEST_DATABASE_URL 設定時のみ実行)。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { pgEnabled } from '../../test/dbBackends';
import type { ResolvedPostgresqlDatasource } from '../../datasource/types';
import { TrinoQueryError } from '../../errors';
import { emptySessionMutations } from '../../trino/types';
import { SQL_BATCH_SIZE } from '../sql/constants';
import { createPostgresqlEngine } from './engine';

function datasourceFromEnv(): ResolvedPostgresqlDatasource {
  const url = process.env.TEST_DATABASE_URL!;
  const parsed = new URL(url);
  return {
    id: 'pg-it',
    type: 'postgresql',
    displayName: 'pg-it',
    username: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 5432,
    database: parsed.pathname.replace(/^\//, ''),
    readOnly: true,
    tls: false,
    maxConnections: 3,
  };
}

describe.skipIf(!pgEnabled)('postgresql engine integration', () => {
  let ds!: ResolvedPostgresqlDatasource;
  let engine!: ReturnType<typeof createPostgresqlEngine>;

  beforeAll(() => {
    ds = datasourceFromEnv();
    engine = createPostgresqlEngine({ datasource: ds });
  });

  it('pages a large SELECT result', async () => {
    const client = engine.executionClient({ source: 'user' });
    const total = SQL_BATCH_SIZE + 3;
    const first = await client.start(
      `SELECT generate_series(1, ${total}) AS n`,
      { source: 'user' },
      emptySessionMutations(),
    );
    expect(first.data).toHaveLength(SQL_BATCH_SIZE);
    expect(first.nextUri).toBeDefined();
    expect(first.stats?.state).toBe('RUNNING');

    const second = await client.advance(
      first.nextUri!,
      { source: 'user' },
      emptySessionMutations(),
    );
    expect(second.data).toHaveLength(3);
    expect(second.nextUri).toBeUndefined();
    expect(second.stats?.state).toBe('FINISHED');
  });

  it('maps syntax errors to USER_ERROR', async () => {
    const client = engine.executionClient({ source: 'user' });
    await expect(
      client.start('SELECT FROM', { source: 'user' }, emptySessionMutations()),
    ).rejects.toBeInstanceOf(TrinoQueryError);
    await expect(
      client.start('SELECT FROM', { source: 'user' }, emptySessionMutations()),
    ).rejects.toMatchObject({ trino: { errorType: 'USER_ERROR' } });
  });

  it('lists catalogs and schemas from information_schema', async () => {
    const catalogs = await engine.listCatalogs({ principal: 'tester' });
    expect(catalogs).toHaveLength(1);
    expect(catalogs[0]!.name).toBe(ds.database);

    const schemas = await engine.listSchemas(catalogs[0]!.name, { principal: 'tester' });
    expect(schemas.some((s) => s.name === 'public')).toBe(true);
  });

  it('rejects INSERT under readOnly session', async () => {
    const client = engine.executionClient({ source: 'user' });
    await expect(
      client.start(
        'CREATE TEMP TABLE ro_test (id int); INSERT INTO ro_test VALUES (1)',
        { source: 'user' },
        emptySessionMutations(),
      ),
    ).rejects.toMatchObject({ trino: { errorType: 'USER_ERROR' } });
  });
});
