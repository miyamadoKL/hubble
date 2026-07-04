import { describe, expect, it, vi } from 'vitest';
import type { ResolvedMysqlDatasource, ResolvedPostgresqlDatasource } from '../datasource/types';
import { createMysqlEngine } from './mysql/engine';
import { createPostgresqlEngine } from './postgresql/engine';

const mysqlDs: ResolvedMysqlDatasource = {
  id: 'mysql-a',
  type: 'mysql',
  displayName: 'mysql-a',
  username: 'default-user',
  password: 'default-pass',
  host: 'mysql.local',
  port: 3306,
  database: 'app',
  readOnly: true,
  tls: false,
  maxConnections: 5,
  roleCredentials: {
    analyst: { username: 'analyst-user', password: 'analyst-pass' },
  },
};

const pgDs: ResolvedPostgresqlDatasource = {
  id: 'pg-a',
  type: 'postgresql',
  displayName: 'pg-a',
  username: 'default-user',
  password: 'default-pass',
  host: 'pg.local',
  port: 5432,
  database: 'app',
  readOnly: true,
  tls: false,
  maxConnections: 5,
  roleCredentials: {
    analyst: { username: 'analyst-user', password: 'analyst-pass' },
  },
};

describe('SQL role credentials', () => {
  it('selects the matching MySQL role credential and falls back to default', async () => {
    const created: Array<{ username: string; password: string }> = [];
    const end = vi.fn(async () => {});
    const poolFactory = (ds: ResolvedMysqlDatasource) => {
      created.push({ username: ds.username, password: ds.password });
      return {
        end,
        on: vi.fn(),
        query: vi.fn(async () => [[]]),
      } as never;
    };
    const engine = createMysqlEngine({ datasource: mysqlDs, poolFactory });

    engine.executionClient({ source: 'user', roleName: 'analyst' });
    engine.executionClient({ source: 'user', roleName: 'viewer' });
    await engine.close();

    expect(created).toEqual([
      { username: 'default-user', password: 'default-pass' },
      { username: 'analyst-user', password: 'analyst-pass' },
    ]);
    expect(end).toHaveBeenCalledTimes(2);
  });

  it('selects the matching PostgreSQL role credential and falls back to default', async () => {
    const created: Array<{ username: string; password: string }> = [];
    const end = vi.fn(async () => {});
    const poolFactory = (ds: ResolvedPostgresqlDatasource) => {
      created.push({ username: ds.username, password: ds.password });
      return {
        end,
        query: vi.fn(async () => ({ rows: [{ name: 'app' }] })),
        connect: vi.fn(),
      } as never;
    };
    const engine = createPostgresqlEngine({ datasource: pgDs, poolFactory });

    engine.executionClient({ source: 'user', roleName: 'analyst' });
    engine.executionClient({ source: 'user', roleName: 'viewer' });
    await engine.close();

    expect(created).toEqual([
      { username: 'default-user', password: 'default-pass' },
      { username: 'analyst-user', password: 'analyst-pass' },
    ]);
    expect(end).toHaveBeenCalledTimes(2);
  });
});
