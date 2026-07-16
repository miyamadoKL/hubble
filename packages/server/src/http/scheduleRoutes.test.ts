/**
 * scheduleRoutes.ts（`/api/schedules`）の統合テスト。
 *
 * `createTestContext` が組み立てる実際の Hono アプリと FakeTrino（Trino のスタブサーバー）を
 * 通して、スケジュールの作成/一覧/取得/更新/削除、EXPLAIN (TYPE VALIDATE) によるバリデーション
 * 挙動（構文エラー時の 400 化、cron 不正時の事前拒否）、手動実行と実行履歴の記録、
 * 実行中スケジュールへの同時実行リクエストが 409 になることを検証する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scheduleSchema, scheduleRunsResponseSchema, type Schedule } from '@hubble/contracts';
import { createTestContext } from '../test/harness';
import type { FakeScenario } from '../test/fakeTrino';

// EXPLAIN (TYPE VALIDATE) が成功（構文的に妥当）を返す共通シナリオ。
const VALIDATE_OK: FakeScenario = {
  match: 'EXPLAIN (TYPE VALIDATE)',
  pages: [{ columns: [{ name: 'result', type: 'boolean' }], data: [[true]] }],
};

function jsonHeaders(): Record<string, string> {
  return { 'content-type': 'application/json' };
}

describe('schedule routes', () => {
  // EXPLAIN VALIDATE が USER_ERROR を返すステートメントは、作成時に 400 VALIDATION_ERROR で
  // 拒否され、Trino のエラーメッセージと行/列情報がレスポンス詳細に含まれることを確認する。
  it('rejects creation with a 400 VALIDATION when EXPLAIN VALIDATE reports USER_ERROR', async () => {
    const ctx = await createTestContext({
      scenarios: [
        {
          match: 'EXPLAIN (TYPE VALIDATE) SELECT_BAD',
          error: {
            message: "line 1:8: mismatched input 'FROM'. Expecting: <expression>",
            errorName: 'SYNTAX_ERROR',
            errorType: 'USER_ERROR',
            errorLocation: { lineNumber: 1, columnNumber: 8 },
          },
        },
      ],
    });
    const res = await ctx.app.request('/api/schedules', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ name: 'bad', statement: 'SELECT_BAD', cron: '* * * * *' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; message: string; details?: Record<string, unknown> };
    };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toContain('mismatched input');
    expect(body.error.details?.line).toBe(1);
    expect(body.error.details?.column).toBe(8);
    await ctx.services.shutdown();
  });

  // cron 式のバリデーションはローカルで完結するため、不正な cron は Trino へ問い合わせる前に
  // 400 で弾かれることを確認する。
  it('rejects an invalid cron with a 400 before reaching Trino', async () => {
    const ctx = await createTestContext({ scenarios: [VALIDATE_OK] });
    const res = await ctx.app.request('/api/schedules', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ name: 'x', statement: 'SELECT 1', cron: 'not a cron' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    await ctx.services.shutdown();
  });

  // スケジュールの CRUD 一連の流れを一通り検証する: 作成時のデフォルト値（enabled/retry/
  // nextRunAt）、一覧、取得、PATCH による再検証込みの部分更新（enabled=false で nextRunAt が
  // null になる）、削除後に一覧が空になることを確認する。
  it('creates, lists, gets, patches (re-validating), and deletes a schedule', async () => {
    const ctx = await createTestContext({ scenarios: [VALIDATE_OK] });

    const createRes = await ctx.app.request('/api/schedules', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        name: 'nightly',
        statement: 'SELECT 1',
        cron: '0 0 * * *',
        catalog: 'tpch',
        schema: 'tiny',
        notifications: {
          onFailure: true,
          channels: ['email'],
          emailTo: ['ops@example.com'],
        },
      }),
    });
    expect(createRes.status).toBe(201);
    const created = scheduleSchema.parse(await createRes.json()) as Schedule;
    expect(created.id).toMatch(/^sch_/);
    expect(created.enabled).toBe(true);
    expect(created.nextRunAt).not.toBeNull();
    expect(created.lastRun).toBeNull();
    expect(created.retry).toEqual({ maxAttempts: 3, backoffSeconds: 60, backoffMultiplier: 2 });
    expect(created.notifications).toEqual({
      onFailure: true,
      channels: ['email'],
      emailTo: ['ops@example.com'],
    });

    const list = (await (await ctx.app.request('/api/schedules')).json()) as unknown[];
    expect(list).toHaveLength(1);

    const got = scheduleSchema.parse(
      await (await ctx.app.request(`/api/schedules/${created.id}`)).json(),
    );
    expect(got.name).toBe('nightly');

    // PATCH changing the statement re-validates (the OK scenario allows it).
    const patchRes = await ctx.app.request(`/api/schedules/${created.id}`, {
      method: 'PATCH',
      headers: jsonHeaders(),
      body: JSON.stringify({ statement: 'SELECT 2', enabled: false }),
    });
    expect(patchRes.status).toBe(200);
    const patched = scheduleSchema.parse(await patchRes.json());
    expect(patched.statement).toBe('SELECT 2');
    expect(patched.enabled).toBe(false);
    // Disabled schedules report no next run.
    expect(patched.nextRunAt).toBeNull();

    const delRes = await ctx.app.request(`/api/schedules/${created.id}`, { method: 'DELETE' });
    expect(delRes.status).toBe(200);
    expect((await (await ctx.app.request('/api/schedules')).json()) as unknown[]).toHaveLength(0);
    await ctx.services.shutdown();
  });

  // datasourceId だけを未知の id に変更した場合、404 で拒否されることを確認する。
  it('PATCH returns 404 when changing to an unknown datasourceId', async () => {
    const ctx = await createTestContext({ scenarios: [VALIDATE_OK] });
    const created = scheduleSchema.parse(
      await (
        await ctx.app.request('/api/schedules', {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ name: 'ok', statement: 'SELECT 1', cron: '* * * * *' }),
        })
      ).json(),
    );

    const res = await ctx.app.request(`/api/schedules/${created.id}`, {
      method: 'PATCH',
      headers: jsonHeaders(),
      body: JSON.stringify({ datasourceId: 'no-such-datasource' }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');

    const got = scheduleSchema.parse(
      await (await ctx.app.request(`/api/schedules/${created.id}`)).json(),
    );
    expect(got.datasourceId).toBe(created.datasourceId);
    await ctx.services.shutdown();
  });

  describe('PATCH datasourceId-only change', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), 'hubble-sched-patch-'));
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    // datasourceId のみの変更でも EXPLAIN (TYPE VALIDATE) による再検証が走ることを確認する。
    it('re-validates when only datasourceId changes', async () => {
      const yamlPath = join(tempDir, 'datasources.yaml');
      writeFileSync(
        yamlPath,
        `datasources:
  - id: trino-a
    type: trino
    username: admin
    baseUrl: http://trino.test
    source: source-a
  - id: trino-b
    type: trino
    username: admin
    baseUrl: http://trino.test
    source: source-b
`,
        'utf8',
      );
      const ctx = await createTestContext({
        scenarios: [VALIDATE_OK],
        env: { DATASOURCES_PATH: yamlPath },
        cwd: tempDir,
      });

      const created = scheduleSchema.parse(
        await (
          await ctx.app.request('/api/schedules', {
            method: 'POST',
            headers: jsonHeaders(),
            body: JSON.stringify({
              name: 'ds-switch',
              statement: 'SELECT 1',
              cron: '* * * * *',
              datasourceId: 'trino-a',
            }),
          })
        ).json(),
      );
      expect(created.datasourceId).toBe('trino-a');

      const validateBefore = ctx.fake.requests.filter(
        (r) => r.method === 'POST' && r.body?.includes('EXPLAIN (TYPE VALIDATE)'),
      ).length;

      const patchRes = await ctx.app.request(`/api/schedules/${created.id}`, {
        method: 'PATCH',
        headers: jsonHeaders(),
        body: JSON.stringify({ datasourceId: 'trino-b' }),
      });
      expect(patchRes.status).toBe(200);
      const patched = scheduleSchema.parse(await patchRes.json());
      expect(patched.datasourceId).toBe('trino-b');
      expect(patched.statement).toBe('SELECT 1');

      const validateAfter = ctx.fake.requests.filter(
        (r) => r.method === 'POST' && r.body?.includes('EXPLAIN (TYPE VALIDATE)'),
      ).length;
      expect(validateAfter).toBeGreaterThan(validateBefore);

      await ctx.services.shutdown();
    });
  });

  // PATCH でステートメントを不正な内容に変更した場合、再検証が走り 400 で拒否されることを確認する。
  it('PATCH rejects a statement that fails validation', async () => {
    const ctx = await createTestContext({
      scenarios: [
        // Specific match first: FakeTrino picks the first substring match, and
        // 'EXPLAIN (TYPE VALIDATE)' is a prefix of this statement's EXPLAIN.
        {
          match: 'EXPLAIN (TYPE VALIDATE) SELECT_BROKEN',
          error: {
            message: 'line 1:1: bad',
            errorName: 'SYNTAX_ERROR',
            errorType: 'USER_ERROR',
            errorLocation: { lineNumber: 1, columnNumber: 1 },
          },
        },
        VALIDATE_OK,
      ],
    });
    const created = scheduleSchema.parse(
      await (
        await ctx.app.request('/api/schedules', {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ name: 'ok', statement: 'SELECT 1', cron: '* * * * *' }),
        })
      ).json(),
    );
    const res = await ctx.app.request(`/api/schedules/${created.id}`, {
      method: 'PATCH',
      headers: jsonHeaders(),
      body: JSON.stringify({ statement: 'SELECT_BROKEN' }),
    });
    expect(res.status).toBe(400);
    await ctx.services.shutdown();
  });

  // 手動実行 (POST /:id/run) が実行履歴レコードを残すこと、および未知の id には 404 が
  // 返ることを確認する。
  it('runs a schedule manually and records the run; returns 404 for unknown ids', async () => {
    const ctx = await createTestContext({
      scenarios: [
        VALIDATE_OK,
        {
          match: 'SELECT_RUN',
          trinoId: 'qrun',
          pages: [{ columns: [{ name: 'n', type: 'bigint' }], data: [[1]] }],
        },
      ],
    });
    const created = scheduleSchema.parse(
      await (
        await ctx.app.request('/api/schedules', {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ name: 'run', statement: 'SELECT_RUN', cron: '* * * * *' }),
        })
      ).json(),
    );

    const runRes = await ctx.app.request(`/api/schedules/${created.id}/run`, { method: 'POST' });
    expect(runRes.status).toBe(202);
    const { runId } = (await runRes.json()) as { runId: string };
    expect(runId).toMatch(/^run_/);

    // Wait for the background run to settle.
    await ctx.services.scheduler.whenIdle();

    const runs = scheduleRunsResponseSchema.parse(
      await (await ctx.app.request(`/api/schedules/${created.id}/runs`)).json(),
    );
    expect(runs.items).toHaveLength(1);
    expect(runs.items[0]!.status).toBe('success');
    expect(runs.items[0]!.rowCount).toBe(1);
    expect(runs.items[0]!.scheduleId).toBe(created.id);

    // Unknown id -> 404.
    const missing = await ctx.app.request('/api/schedules/sch_nope/run', { method: 'POST' });
    expect(missing.status).toBe(404);
    await ctx.services.shutdown();
  });

  // 同一スケジュールに対して実行中に重ねて手動実行を要求すると 409 CONFLICT になることを確認する。
  it('returns 409 when a run is already in progress', async () => {
    const ctx = await createTestContext({
      scenarios: [
        VALIDATE_OK,
        {
          match: 'SELECT_HOLD',
          pages: [{ columns: [{ name: 'n', type: 'bigint' }], data: [[1]] }],
        },
      ],
    });
    const created = scheduleSchema.parse(
      await (
        await ctx.app.request('/api/schedules', {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ name: 'hold', statement: 'SELECT_HOLD', cron: '* * * * *' }),
        })
      ).json(),
    );

    // 作成時の検証が完了した後、後続のadvanceをすべて止める。
    // これで最初の実行を処理中に保ち、2回目を競合にする。
    const holdAdvance = Promise.withResolvers<void>();
    ctx.fake.holdAdvance = holdAdvance.promise;
    try {
      const first = await ctx.app.request(`/api/schedules/${created.id}/run`, {
        method: 'POST',
      });
      expect(first.status).toBe(202);
      const second = await ctx.app.request(`/api/schedules/${created.id}/run`, {
        method: 'POST',
      });
      expect(second.status).toBe(409);
      const body = (await second.json()) as { error: { code: string } };
      expect(body.error.code).toBe('CONFLICT');
    } finally {
      holdAdvance.resolve();
      await ctx.services.scheduler.whenIdle();
      await ctx.services.shutdown();
    }
  });

  it('does not report a database failure as a run conflict', async () => {
    const ctx = await createTestContext({ scenarios: [VALIDATE_OK] });
    const created = scheduleSchema.parse(
      await (
        await ctx.app.request('/api/schedules', {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ name: 'db-failure', statement: 'SELECT 1', cron: '* * * * *' }),
        })
      ).json(),
    );
    vi.spyOn(ctx.services.scheduleRuns, 'start').mockRejectedValueOnce(
      new Error('database unavailable'),
    );

    const response = await ctx.app.request(`/api/schedules/${created.id}/run`, { method: 'POST' });

    expect(response.status).toBe(500);
    expect((await response.json()) as unknown).toMatchObject({ error: { code: 'INTERNAL' } });
    await ctx.services.shutdown();
  });
});
