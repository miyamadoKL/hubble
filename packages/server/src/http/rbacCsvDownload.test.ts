/**
 * CSV ダウンロード再実行経路の RBAC enforcement テスト。
 */
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { FieldPacket } from 'mysql2/promise';
import type { FieldDef } from 'pg';
import { CSV_REEXEC_HEADER } from '../query/csv';
import { createTestContext } from '../test/harness';
import { emptySessionMutations } from '../trino/types';
import { createMysqlEngine } from '../engine/mysql/engine';
import type { MysqlPool } from '../engine/mysql/pool';
import { createPostgresqlEngine } from '../engine/postgresql/engine';
import type { PgPool } from '../engine/postgresql/pool';
import type { ResolvedMysqlDatasource, ResolvedPostgresqlDatasource } from '../datasource/types';

const MYSQL_DS: ResolvedMysqlDatasource = {
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

const PG_DS: ResolvedPostgresqlDatasource = {
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

const MYSQL_FIELDS = [{ name: 'n', type: 'LONG' }] as unknown as FieldPacket[];
const PG_FIELDS: FieldDef[] = [
  {
    name: 'n',
    tableID: 0,
    columnID: 0,
    dataTypeID: 23,
    dataTypeSize: 4,
    dataTypeModifier: -1,
    format: 'text',
  },
];

function makeFakeMysqlPool(sqlLog: string[]): MysqlPool {
  return {
    getConnection: async () => ({
      threadId: 1,
      connection: {
        query: () => ({
          stream: () => {
            const stream = new Readable({ objectMode: true, read() {} });
            queueMicrotask(() => {
              stream.emit('fields', MYSQL_FIELDS);
              stream.push([1]);
              stream.push(null);
            });
            return stream;
          },
        }),
      },
      release: () => {},
      destroy: () => {},
      query: async (sql: string) => {
        if (sql.startsWith('SET SESSION')) sqlLog.push(sql);
      },
    }),
  } as unknown as MysqlPool;
}

function makeFakePgPool(sqlLog: string[]): PgPool {
  return {
    connect: async () => ({
      query: (arg: unknown) => {
        if (typeof arg === 'string') {
          if (arg.startsWith('SET default_transaction_read_only')) sqlLog.push(arg);
          return Promise.resolve({ rows: [{ pid: 1 }] });
        }
        const cursor = arg as {
          read: (n: number) => Promise<unknown[][]>;
          close: () => Promise<void>;
          _result?: { fields: FieldDef[] };
        };
        cursor._result = { fields: PG_FIELDS };
        cursor.read = async () => [[1]];
        cursor.close = async () => {};
      },
      release: () => {},
    }),
  } as unknown as PgPool;
}

function writeRbac(dir: string): void {
  writeFileSync(
    join(dir, 'rbac.yaml'),
    `roles:
  readonly:
    permissions: []
    datasources: ['*']
  writer:
    permissions: [query.write]
    datasources: ['*']
assignments:
  - user: reader
    role: readonly
  - user: writer
    role: writer
defaultRole: readonly
`,
    'utf8',
  );
}

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

function proxyHeaders(user: string): Record<string, string> {
  return {
    'x-forwarded-user': user,
    'x-forwarded-email': `${user}@example.com`,
  };
}

describe('CSV download write enforcement', () => {
  it('does not re-exec INSERT for readonly user (buffered rows only)', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'hubble-rbac-csv-'));
    writeRbac(tempDir);
    const ctx = await createTestContext({
      cwd: tempDir,
      env: { AUTH_MODE: 'proxy', AUTH_USER_MAPPING: 'user' },
      remoteAddress: () => '127.0.0.1',
      scenarios: [
        {
          match: 'insert',
          trinoId: 'insert',
          pages: [
            {
              columns: [{ name: 'n', type: 'bigint' }],
              data: [[1], [2]],
              state: 'FINISHED',
            },
          ],
        },
      ],
    });

    const exec = ctx.services.registry.submit({
      statement: 'INSERT INTO t SELECT * FROM insert',
      ctx: { source: 'test', user: 'reader' },
      maxRows: 1,
    });
    await exec.settled;
    expect(exec.truncated).toBe(true);

    const postsBefore = ctx.fake.requests.filter((r) => r.method === 'POST').length;
    const res = await ctx.app.request(`/api/queries/${exec.queryId}/download.csv`, {
      headers: proxyHeaders('reader'),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get(CSV_REEXEC_HEADER)).toBe('unavailable');
    expect(ctx.fake.requests.filter((r) => r.method === 'POST').length).toBe(postsBefore);

    await ctx.services.shutdown();
  });

  it('mysql downloadClient applies session read only on CSV re-exec', async () => {
    const sqlLog: string[] = [];
    const engine = createMysqlEngine({
      datasource: MYSQL_DS,
      poolFactory: () => makeFakeMysqlPool(sqlLog),
    });
    const client = engine.downloadClient({ sessionReadOnly: true });
    await client.start('SELECT 1', { source: 'hubble-download' }, emptySessionMutations());
    expect(sqlLog).toContain('SET SESSION TRANSACTION READ ONLY');
  });

  it('postgresql downloadClient applies session read only on CSV re-exec', async () => {
    const sqlLog: string[] = [];
    const engine = createPostgresqlEngine({
      datasource: PG_DS,
      poolFactory: () => makeFakePgPool(sqlLog),
    });
    const client = engine.downloadClient({ sessionReadOnly: true });
    await client.start('SELECT 1', { source: 'hubble-download' }, emptySessionMutations());
    expect(sqlLog).toContain('SET default_transaction_read_only = on');
  });
});
