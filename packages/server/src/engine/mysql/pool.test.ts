/**
 * MySQL プール生成の不変条件テスト。
 */
import mysql from 'mysql2/promise';
import { describe, expect, it, vi, afterEach } from 'vitest';
import type { ResolvedMysqlDatasource } from '../../datasource/types';
import { createMysqlPool } from './pool';

const DS: ResolvedMysqlDatasource = {
  id: 'mysql-a',
  type: 'mysql',
  displayName: 'mysql-a',
  username: 'u',
  password: 'p',
  host: '127.0.0.1',
  port: 3306,
  database: 'db',
  readOnly: false,
  tls: false,
  maxConnections: 2,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('createMysqlPool', () => {
  it('does not enable multipleStatements on the pool', () => {
    const fakePool = { on: vi.fn() };
    const createPool = vi.spyOn(mysql, 'createPool').mockReturnValue(fakePool as never);
    createMysqlPool(DS);

    expect(createPool).toHaveBeenCalledOnce();
    const options = createPool.mock.calls[0]![0] as Record<string, unknown>;
    expect(options.multipleStatements).toBeUndefined();
    expect(options.multipleStatements).not.toBe(true);
  });

  it('設定した接続タイムアウトをpoolへ渡す', () => {
    vi.stubEnv('DATASOURCE_CONNECT_TIMEOUT_MS', '4321');
    const fakePool = { on: vi.fn() };
    const createPool = vi.spyOn(mysql, 'createPool').mockReturnValue(fakePool as never);

    createMysqlPool(DS);

    expect(createPool.mock.calls[0]![0]).toMatchObject({ connectTimeout: 4321 });
  });

  it('BIGINTを精度損失なく文字列として取得する設定を渡す', () => {
    const fakePool = { on: vi.fn() };
    const createPool = vi.spyOn(mysql, 'createPool').mockReturnValue(fakePool as never);

    createMysqlPool(DS);

    expect(createPool.mock.calls[0]![0]).toMatchObject({
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
  });
});
