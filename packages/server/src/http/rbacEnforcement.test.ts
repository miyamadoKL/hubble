/**
 * RBAC Phase B: query.write とロール別 Query Guard の統合テスト。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiError } from '@hubble/contracts';
import { WRITE_NOT_ALLOWED } from '@hubble/contracts';
import { createTestContext } from '../test/harness';
import type { FakeScenario } from '../test/fakeTrino';

const VALIDATE_OK: FakeScenario = {
  match: 'EXPLAIN (TYPE VALIDATE)',
  pages: [{ columns: [{ name: 'result', type: 'boolean' }], data: [[true]] }],
};

function ioPlanCell(opts: { writes?: boolean }): string {
  return JSON.stringify({
    inputTableColumnInfos: [
      {
        table: { catalog: 'tpch', schemaTable: { schema: 'tiny', table: 'nation' } },
        estimate: { outputRowCount: 25, outputSizeInBytes: 2734 },
      },
    ],
    outputTableColumnInfos: opts.writes
      ? [
          {
            table: { catalog: 'tpch', schemaTable: { schema: 'tiny', table: 'out' } },
            estimate: { outputRowCount: 25, outputSizeInBytes: 2734 },
          },
        ]
      : [],
    estimate: { outputRowCount: 25, outputSizeInBytes: 2734 },
  });
}

function explainScenario(match: string, cell: string): FakeScenario {
  return {
    match,
    pages: [
      { columns: [{ name: 'Query Plan', type: 'varchar' }], data: [[cell]], state: 'FINISHED' },
    ],
  };
}

const nationScenario: FakeScenario = {
  match: 'nation',
  pages: [
    {
      columns: [{ name: 'n', type: 'bigint' }],
      data: [[1]],
      state: 'FINISHED',
    },
  ],
};

function writeRbac(dir: string): void {
  writeFileSync(
    join(dir, 'rbac.yaml'),
    `roles:
  readonly:
    permissions: []
  writer:
    permissions: [query.write]
  member:
    permissions: []
    guard:
      maxScanBytes: 1000
      onUnknown: block
assignments:
  - user: reader
    role: readonly
  - user: writer
    role: writer
  - user: member
    role: member
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

function rbacDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'hubble-rbac-b-'));
  writeRbac(tempDir);
  return tempDir;
}

function proxyHeaders(user: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-forwarded-user': user,
    'x-forwarded-email': `${user}@example.com`,
  };
}

async function rbacCtx(options: Parameters<typeof createTestContext>[0] = {}) {
  const cwd = options.cwd ?? rbacDir();
  return createTestContext({
    ...options,
    cwd,
    env: { AUTH_MODE: 'proxy', AUTH_USER_MAPPING: 'user', ...options.env },
    remoteAddress: options.remoteAddress ?? (() => '127.0.0.1'),
  });
}

describe('RBAC query.write enforcement', () => {
  it('returns 403 WRITE_NOT_ALLOWED for INSERT with readonly role', async () => {
    const ctx = await rbacCtx();
    const res = await ctx.app.request('/api/queries', {
      method: 'POST',
      headers: proxyHeaders('reader'),
      body: JSON.stringify({ statement: 'INSERT INTO t VALUES (1)' }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as ApiError;
    expect(body.error.code).toBe(WRITE_NOT_ALLOWED);
    await ctx.services.shutdown();
  });

  it('allows SELECT for readonly role', async () => {
    const ctx = await rbacCtx({ scenarios: [nationScenario] });
    const res = await ctx.app.request('/api/queries', {
      method: 'POST',
      headers: proxyHeaders('reader'),
      body: JSON.stringify({ statement: 'SELECT * FROM nation', catalog: 'tpch' }),
    });
    expect(res.status).toBe(202);
    await ctx.services.shutdown();
  });

  it('allows EXPLAIN ANALYZE SELECT for readonly role', async () => {
    const ctx = await rbacCtx({ scenarios: [nationScenario] });
    const res = await ctx.app.request('/api/queries', {
      method: 'POST',
      headers: proxyHeaders('reader'),
      body: JSON.stringify({
        statement: 'EXPLAIN ANALYZE SELECT * FROM nation',
        catalog: 'tpch',
      }),
    });
    expect(res.status).toBe(202);
    await ctx.services.shutdown();
  });

  it('denies EXPLAIN ANALYZE INSERT for readonly role', async () => {
    const ctx = await rbacCtx();
    const res = await ctx.app.request('/api/queries', {
      method: 'POST',
      headers: proxyHeaders('reader'),
      body: JSON.stringify({ statement: 'EXPLAIN ANALYZE INSERT INTO t VALUES (1)' }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as ApiError;
    expect(body.error.code).toBe(WRITE_NOT_ALLOWED);
    await ctx.services.shutdown();
  });

  it('blocks CTAS detected by IO explain for readonly role', async () => {
    const ctx = await rbacCtx({
      scenarios: [explainScenario('CREATE TABLE out AS', ioPlanCell({ writes: true }))],
    });
    const res = await ctx.app.request('/api/queries', {
      method: 'POST',
      headers: proxyHeaders('reader'),
      body: JSON.stringify({
        statement: 'CREATE TABLE out AS SELECT * FROM nation',
        catalog: 'tpch',
      }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as ApiError;
    expect(body.error.code).toBe(WRITE_NOT_ALLOWED);
    await ctx.services.shutdown();
  });

  it('rejects write schedule creation for readonly owner', async () => {
    const ctx = await rbacCtx({ scenarios: [VALIDATE_OK] });
    const res = await ctx.app.request('/api/schedules', {
      method: 'POST',
      headers: proxyHeaders('reader'),
      body: JSON.stringify({
        name: 'bad',
        statement: 'INSERT INTO t VALUES (1)',
        cron: '* * * * *',
      }),
    });
    expect(res.status).toBe(403);
    await ctx.services.shutdown();
  });
});

describe('RBAC role-specific Query Guard', () => {
  it('isolates estimate cache between roles', async () => {
    const cell = ioPlanCell({ writes: false });
    const ctx = await rbacCtx({
      scenarios: [explainScenario('lineitem', cell)],
      configOverrides: {
        guard: {
          mode: 'enforce',
          maxScanBytes: 0,
          maxScanRows: 1_000_000,
          onUnknown: 'warn',
          estimateTimeoutMs: 3000,
          cacheTtlSeconds: 60,
          bytesPerSecond: 0,
        },
      },
    });

    const stmt = { statement: 'SELECT * FROM lineitem', catalog: 'tpch' };
    const writerRes = await ctx.app.request('/api/queries/estimate', {
      method: 'POST',
      headers: proxyHeaders('writer'),
      body: JSON.stringify(stmt),
    });
    expect(writerRes.status).toBe(200);

    const memberRes = await ctx.app.request('/api/queries/estimate', {
      method: 'POST',
      headers: proxyHeaders('member'),
      body: JSON.stringify(stmt),
    });
    expect(memberRes.status).toBe(200);
    const memberBody = (await memberRes.json()) as { verdict: { decision: string } };
    expect(memberBody.verdict.decision).toBe('block');

    const explainCalls = ctx.fake.requests.filter(
      (r) => r.method === 'POST' && (r.body ?? '').includes('EXPLAIN (TYPE IO'),
    );
    expect(explainCalls.length).toBe(2);
    await ctx.services.shutdown();
  });
});
