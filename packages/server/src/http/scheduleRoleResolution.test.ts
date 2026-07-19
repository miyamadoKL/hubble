/**
 * スケジュール実行時の RBAC principal 復元を検証する。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { scheduleRunsResponseSchema, scheduleSchema } from '@hubble/contracts';
import { createTestContext } from '../test/harness';
import type { FakeScenario } from '../test/fakeTrino';

const VALIDATE_OK: FakeScenario = {
  match: 'EXPLAIN (TYPE VALIDATE)',
  pages: [{ columns: [{ name: 'result', type: 'boolean' }], data: [[true]] }],
};

const SELECT_SNAPSHOT: FakeScenario = {
  match: 'snapshot_value',
  trinoId: 'q_snapshot',
  pages: [{ columns: [{ name: 'n', type: 'bigint' }], data: [[1]], state: 'FINISHED' }],
};

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir !== undefined) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

function makeTempDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'hubble-sched-role-'));
  return tempDir;
}

function writeRbac(dir: string, assignment: string): void {
  writeFileSync(
    join(dir, 'rbac.yaml'),
    `roles:
  noaccess:
    permissions: []
    datasources: []
  runner:
    permissions: []
    datasources: [trino-default]
assignments:
${assignment}
defaultRole: noaccess
`,
    'utf8',
  );
}

function proxyHeaders(options: { email: string; groups?: string }): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-forwarded-user': 'sso-user',
    'x-forwarded-email': options.email,
    ...(options.groups !== undefined ? { 'x-forwarded-groups': options.groups } : {}),
  };
}

async function createSnapshotSchedule(
  assignment: string,
): Promise<Awaited<ReturnType<typeof createTestContext>>> {
  const cwd = makeTempDir();
  writeRbac(cwd, assignment);
  return createTestContext({
    cwd,
    scenarios: [VALIDATE_OK, SELECT_SNAPSHOT],
    env: { AUTH_MODE: 'proxy', AUTH_USER_MAPPING: 'email-localpart' },
    remoteAddress: () => '127.0.0.1',
  });
}

describe('schedule execution role resolution', () => {
  it.each([
    {
      name: 'email assignment',
      assignment: `  - email: alice@example.com
    role: runner`,
      headers: proxyHeaders({ email: 'alice@example.com' }),
    },
    {
      name: 'emailDomain assignment',
      assignment: `  - emailDomain: example.com
    role: runner`,
      headers: proxyHeaders({ email: 'alice@example.com' }),
    },
    {
      name: 'group assignment',
      assignment: `  - group: analytics
    role: runner`,
      headers: proxyHeaders({ email: 'alice@example.com', groups: 'analytics, finance' }),
    },
  ])(
    'uses the saved principal snapshot for $name under email-localpart',
    async ({ assignment, headers }) => {
      const ctx = await createSnapshotSchedule(assignment);
      // email-localpart マッピングなので、principal.user はメールの @ より前 ('alice') になる。
      const saved = await ctx.services.savedQueries.create('alice', {
        name: 'snapshot-sq',
        statement: 'SELECT 1 AS snapshot_value',
      });
      const createRes = await ctx.app.request('/api/schedules', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: 'snapshot',
          savedQueryId: saved.id,
          cron: '* * * * *',
        }),
      });
      expect(createRes.status).toBe(201);
      const created = scheduleSchema.parse(await createRes.json());

      const runRes = await ctx.app.request(`/api/schedules/${created.id}/run`, {
        method: 'POST',
        headers,
      });
      expect(runRes.status).toBe(202);
      await ctx.services.scheduler.whenIdle();

      const runs = scheduleRunsResponseSchema.parse(
        await (
          await ctx.app.request(`/api/schedules/${created.id}/runs`, {
            headers,
          })
        ).json(),
      );
      expect(runs.items[0]?.status).toBe('success');
      expect(runs.items[0]?.rowCount).toBe(1);
      await ctx.services.shutdown();
    },
  );
});
