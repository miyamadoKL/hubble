/**
 * RBAC Phase C: 管理 API（Operations ビュー）の統合テスト。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiRoutes, type ApiError } from '@hubble/contracts';
import { createTestContext, waitForTerminal } from '../test/harness';
import type { FakeScenario } from '../test/fakeTrino';

const slowScenario: FakeScenario = {
  match: 'slow-query',
  pages: [
    {
      columns: [{ name: 'n', type: 'bigint' }],
      data: [[1]],
      state: 'RUNNING',
    },
    {
      columns: [{ name: 'n', type: 'bigint' }],
      data: [[2]],
      state: 'FINISHED',
    },
  ],
};

function writeRbac(dir: string): void {
  writeFileSync(
    join(dir, 'rbac.yaml'),
    `roles:
  viewer:
    permissions: [queries.viewAll]
    datasources: ['*']
  killer:
    permissions: [queries.viewAll, query.killAny]
    datasources: ['*']
  auditor:
    permissions: [audit.view]
    datasources: ['*']
  runner:
    permissions: [query.write]
    datasources: ['*']
assignments:
  - user: viewer
    role: viewer
  - user: killer
    role: killer
  - user: alice
    role: runner
  - user: auditor
    role: auditor
  - user: bob
    role: runner
defaultRole: runner
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
    'content-type': 'application/json',
    'x-forwarded-user': user,
    'x-forwarded-email': `${user}@example.com`,
  };
}

async function adminCtx() {
  tempDir = mkdtempSync(join(tmpdir(), 'hubble-rbac-c-'));
  writeRbac(tempDir);
  return createTestContext({
    cwd: tempDir,
    env: { AUTH_MODE: 'proxy', AUTH_USER_MAPPING: 'user' },
    remoteAddress: () => '127.0.0.1',
    scenarios: [slowScenario],
  });
}

describe('admin queries API', () => {
  it('requires audit.view and returns cursor-paged audit logs', async () => {
    const ctx = await adminCtx();
    await ctx.services.audit.record({
      actor: 'alice',
      action: 'query.execute',
      datasource: 'trino-default',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    await ctx.services.audit.record({
      actor: 'bob',
      action: 'query.kill',
      datasource: 'trino-default',
      createdAt: '2026-01-02T00:00:00.000Z',
    });

    const denied = await ctx.app.request(apiRoutes.adminAuditLogs(), {
      headers: proxyHeaders('viewer'),
    });
    expect(denied.status).toBe(403);

    const first = await ctx.app.request(`${apiRoutes.adminAuditLogs()}?limit=1`, {
      headers: proxyHeaders('auditor'),
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      items: Array<{ actor: string }>;
      nextCursor: string;
    };
    expect(firstBody.items).toHaveLength(1);
    expect(firstBody.nextCursor).toBeTruthy();
    const second = await ctx.app.request(
      `${apiRoutes.adminAuditLogs()}?limit=10&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
      { headers: proxyHeaders('auditor') },
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { items: Array<{ actor: string }> };
    expect(secondBody.items.length).toBeGreaterThan(0);
    await ctx.services.shutdown();
  });

  it('returns 403 without queries.viewAll', async () => {
    const ctx = await adminCtx();
    const res = await ctx.app.request(apiRoutes.adminQueries(), {
      headers: proxyHeaders('alice'),
    });
    expect(res.status).toBe(403);
    await ctx.services.shutdown();
  });

  it('lists another user query with owner and truncated statement', async () => {
    const ctx = await adminCtx();
    const submit = await ctx.app.request('/api/queries', {
      method: 'POST',
      headers: proxyHeaders('bob'),
      body: JSON.stringify({ statement: 'SELECT ' + 'x'.repeat(250) + ' FROM slow-query' }),
    });
    expect(submit.status).toBe(202);
    const { queryId } = (await submit.json()) as { queryId: string };

    const res = await ctx.app.request(apiRoutes.adminQueries(), {
      headers: proxyHeaders('viewer'),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{
        queryId: string;
        owner: string;
        datasourceId: string;
        statement: string;
        state: string;
      }>;
    };
    const item = body.items.find((i) => i.queryId === queryId);
    expect(item).toBeDefined();
    expect(item!.owner).toBe('bob');
    expect(item!.datasourceId).toBeTruthy();
    expect(item!.statement).toHaveLength(200);
    expect(item!.statement).not.toContain('password');
    await ctx.services.shutdown();
  });

  it('returns 403 for kill without query.killAny', async () => {
    const ctx = await adminCtx();
    const submit = await ctx.app.request('/api/queries', {
      method: 'POST',
      headers: proxyHeaders('bob'),
      body: JSON.stringify({ statement: 'SELECT 1 FROM slow-query' }),
    });
    const { queryId } = (await submit.json()) as { queryId: string };

    const res = await ctx.app.request(apiRoutes.adminQuery(queryId), {
      method: 'DELETE',
      headers: proxyHeaders('viewer'),
    });
    expect(res.status).toBe(403);
    await ctx.services.shutdown();
  });

  it('kills another user query and logs audit line', async () => {
    const ctx = await adminCtx();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const submit = await ctx.app.request('/api/queries', {
      method: 'POST',
      headers: proxyHeaders('bob'),
      body: JSON.stringify({ statement: 'SELECT 1 FROM slow-query' }),
    });
    const { queryId } = (await submit.json()) as { queryId: string };

    const res = await ctx.app.request(apiRoutes.adminQuery(queryId), {
      method: 'DELETE',
      headers: proxyHeaders('killer'),
    });
    expect(res.status).toBe(200);

    expect(logSpy).toHaveBeenCalledWith(
      `[rbac] admin kill: actor=killer targetOwner=bob queryId=${queryId}`,
    );
    const auditRows = await ctx.services.audit.listForTest();
    const killAudit = auditRows.find((row) => row.action === 'query.kill');
    expect(killAudit).toMatchObject({
      actor: 'killer',
      target: queryId,
      datasource: 'trino-default',
    });
    expect(killAudit?.detail).toMatchObject({ targetOwner: 'bob' });
    logSpy.mockRestore();
    await ctx.services.shutdown();
  });

  it('cancels a running query via admin kill', async () => {
    const ctx = await adminCtx();
    const submit = await ctx.app.request('/api/queries', {
      method: 'POST',
      headers: proxyHeaders('bob'),
      body: JSON.stringify({ statement: 'SELECT 1 FROM slow-query' }),
    });
    const { queryId } = (await submit.json()) as { queryId: string };

    const killRes = await ctx.app.request(apiRoutes.adminQuery(queryId), {
      method: 'DELETE',
      headers: proxyHeaders('killer'),
    });
    expect(killRes.status).toBe(200);

    await waitForTerminal(ctx.services, queryId);
    const snap = ctx.services.registry.get(queryId)!.snapshot();
    expect(snap.state).toBe('canceled');

    await ctx.services.shutdown();
  });

  it('returns NOT_FOUND envelope for unknown query id', async () => {
    const ctx = await adminCtx();
    const res = await ctx.app.request(apiRoutes.adminQuery('q_missing'), {
      method: 'DELETE',
      headers: proxyHeaders('killer'),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as ApiError;
    expect(body.error.code).toBe('NOT_FOUND');
    await ctx.services.shutdown();
  });
});
