import { describe, expect, it } from 'vitest';
import { scheduleSchema, scheduleRunsResponseSchema, type Schedule } from '@hubble/contracts';
import { createTestContext } from '../test/harness';
import type { FakeScenario } from '../test/fakeTrino';

const VALIDATE_OK: FakeScenario = {
  match: 'EXPLAIN (TYPE VALIDATE)',
  pages: [{ columns: [{ name: 'result', type: 'boolean' }], data: [[true]] }],
};

function jsonHeaders(): Record<string, string> {
  return { 'content-type': 'application/json' };
}

describe('schedule routes', () => {
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
      }),
    });
    expect(createRes.status).toBe(201);
    const created = scheduleSchema.parse(await createRes.json()) as Schedule;
    expect(created.id).toMatch(/^sch_/);
    expect(created.enabled).toBe(true);
    expect(created.nextRunAt).not.toBeNull();
    expect(created.lastRun).toBeNull();
    expect(created.retry).toEqual({ maxAttempts: 3, backoffSeconds: 60, backoffMultiplier: 2 });

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

    // After create's validation has completed, hold all subsequent advances so
    // the first run stays in flight and the second is a conflict.
    ctx.fake.holdAdvance = new Promise(() => {});

    const first = await ctx.app.request(`/api/schedules/${created.id}/run`, { method: 'POST' });
    expect(first.status).toBe(202);
    const second = await ctx.app.request(`/api/schedules/${created.id}/run`, { method: 'POST' });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: { code: string } };
    expect(body.error.code).toBe('CONFLICT');
    // Note: do not call shutdown() here — it would await the held run forever.
  });
});
