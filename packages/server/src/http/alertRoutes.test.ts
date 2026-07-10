/**
 * alertRoutes.ts の統合テスト。
 */
import { describe, expect, it, vi } from 'vitest';
import { alertEvalResponseSchema, alertSchema, type Alert } from '@hubble/contracts';
import { createTestContext } from '../test/harness';
import type { FakeScenario } from '../test/fakeTrino';

const QUERY_OK: FakeScenario = {
  match: 'SELECT alert_val',
  pages: [{ columns: [{ name: 'count', type: 'bigint' }], data: [[150]] }],
};

const VALIDATE_OK: FakeScenario = {
  match: 'EXPLAIN (TYPE VALIDATE)',
  pages: [{ columns: [{ name: 'result', type: 'boolean' }], data: [[true]] }],
};

const QUERY_TRUNCATED: FakeScenario = {
  match: 'SELECT alert_many',
  pages: [
    {
      columns: [{ name: 'count', type: 'bigint' }],
      data: Array.from({ length: 10_000 }, (_, index) => [index]),
      state: 'RUNNING',
    },
    { data: [[10_000]], state: 'FINISHED' },
  ],
};

function jsonHeaders(): Record<string, string> {
  return { 'content-type': 'application/json' };
}

describe('alert routes', () => {
  it('creates, lists, updates, evaluates, and deletes an alert', async () => {
    const ctx = await createTestContext({ scenarios: [VALIDATE_OK, QUERY_OK] });

    const sqRes = await ctx.app.request('/api/saved-queries', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ name: 'metric', statement: 'SELECT alert_val' }),
    });
    expect(sqRes.status).toBe(201);
    const sq = (await sqRes.json()) as { id: string };

    const createRes = await ctx.app.request('/api/alerts', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        name: 'spike',
        savedQueryId: sq.id,
        columnName: 'count',
        op: '>',
        value: '100',
        selector: 'first',
        cron: '0 * * * *',
        notifications: { channels: ['slack'] },
      }),
    });
    expect(createRes.status).toBe(201);
    const created = alertSchema.parse(await createRes.json()) as Alert;
    expect(created.id).toMatch(/^alt_/);
    expect(created.state).toBe('unknown');

    const list = (await (await ctx.app.request('/api/alerts')).json()) as unknown[];
    expect(list).toHaveLength(1);

    const putRes = await ctx.app.request(`/api/alerts/${created.id}`, {
      method: 'PUT',
      headers: jsonHeaders(),
      body: JSON.stringify({
        name: 'spike-updated',
        savedQueryId: sq.id,
        columnName: 'count',
        op: '>',
        value: '100',
        selector: 'first',
        rearm: 0,
        muted: false,
        cron: '0 * * * *',
        notifications: { channels: ['slack'] },
      }),
    });
    expect(putRes.status).toBe(200);

    const evalRes = await ctx.app.request(`/api/alerts/${created.id}/eval`, {
      method: 'POST',
      headers: jsonHeaders(),
    });
    expect(evalRes.status).toBe(200);
    const evalBody = alertEvalResponseSchema.parse(await evalRes.json());
    expect(evalBody.conditionMet).toBe(true);
    expect(evalBody.state).toBe('triggered');

    const got = alertSchema.parse(
      await (await ctx.app.request(`/api/alerts/${created.id}`)).json(),
    );
    expect(got.state).toBe('triggered');

    const delRes = await ctx.app.request(`/api/alerts/${created.id}`, { method: 'DELETE' });
    expect(delRes.status).toBe(200);

    await ctx.services.shutdown();
  });

  it('cancels and does not notify when the evaluation result is truncated', async () => {
    const ctx = await createTestContext({ scenarios: [VALIDATE_OK, QUERY_TRUNCATED] });
    const sendNotification = vi.spyOn(ctx.services.notifications, 'sendAlertTriggered');

    const sqRes = await ctx.app.request('/api/saved-queries', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ name: 'large metric', statement: 'SELECT alert_many' }),
    });
    const sq = (await sqRes.json()) as { id: string };
    const createRes = await ctx.app.request('/api/alerts', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        name: 'large spike',
        savedQueryId: sq.id,
        columnName: 'count',
        op: '>',
        value: '100',
        selector: 'max',
        cron: '0 * * * *',
        notifications: { channels: ['slack'] },
      }),
    });
    const created = alertSchema.parse(await createRes.json()) as Alert;

    const evalRes = await ctx.app.request(`/api/alerts/${created.id}/eval`, {
      method: 'POST',
      headers: jsonHeaders(),
    });
    expect(evalRes.status).toBe(200);
    expect(alertEvalResponseSchema.parse(await evalRes.json())).toMatchObject({
      conditionMet: false,
      observedValue: null,
      notified: false,
      errorType: 'RESULT_TRUNCATED',
    });
    expect(sendNotification).not.toHaveBeenCalled();
    expect(ctx.fake.requests.some((request) => request.method === 'DELETE')).toBe(true);

    await ctx.services.shutdown();
  });
});
