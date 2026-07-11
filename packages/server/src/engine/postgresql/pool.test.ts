/** PostgreSQLプール生成の接続期限テスト。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedPostgresqlDatasource } from '../../datasource/types';
import { createPgPool } from './pool';

const DS: ResolvedPostgresqlDatasource = {
  id: 'pg-a',
  type: 'postgresql',
  displayName: 'pg-a',
  username: 'u',
  password: 'p',
  host: '127.0.0.1',
  port: 5432,
  database: 'db',
  readOnly: false,
  tls: false,
  maxConnections: 2,
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createPgPool', () => {
  it('設定した接続タイムアウトをpoolへ渡す', async () => {
    vi.stubEnv('DATASOURCE_CONNECT_TIMEOUT_MS', '4321');

    const pool = createPgPool(DS);

    expect(pool.options.connectionTimeoutMillis).toBe(4321);
    await pool.end();
  });
});
