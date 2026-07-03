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
});
