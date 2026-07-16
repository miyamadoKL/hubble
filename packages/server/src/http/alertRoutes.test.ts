/**
 * alertRoutes.ts の統合テスト。
 */
import { describe, expect, it, vi } from 'vitest';
import { alertEvalResponseSchema, alertSchema, type Alert } from '@hubble/contracts';
import { createTestContext } from '../test/harness';
import { AlertDeliveryRepository } from '../store/alertDeliveries';
import type { FakeScenario } from '../test/fakeTrino';

const QUERY_OK: FakeScenario = {
  match: 'SELECT alert_val',
  pages: [{ columns: [{ name: 'count', type: 'bigint' }], data: [[150]] }],
};

const QUERY_INVALID_NUMERIC: FakeScenario = {
  match: 'SELECT invalid_numeric',
  pages: [{ columns: [{ name: 'count', type: 'bigint' }], data: [['not-a-number']] }],
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

const aliceHeaders = { ...jsonHeaders(), 'x-forwarded-email': 'alice@corp.com' };
const bobHeaders = { ...jsonHeaders(), 'x-forwarded-email': 'bob@corp.com' };

async function createAlertForSharedQuery(
  ctx: Awaited<ReturnType<typeof createTestContext>>,
  cron: string,
): Promise<Alert> {
  const savedQueryResponse = await ctx.app.request('/api/saved-queries', {
    method: 'POST',
    headers: aliceHeaders,
    body: JSON.stringify({ name: 'shared metric', statement: 'SELECT alert_val' }),
  });
  const savedQuery = (await savedQueryResponse.json()) as { id: string };
  await ctx.app.request(`/api/saved-queries/${savedQuery.id}/shares`, {
    method: 'PUT',
    headers: aliceHeaders,
    body: JSON.stringify({
      shares: [{ subjectType: 'user', subjectValue: 'bob', permission: 'view' }],
    }),
  });
  const alertResponse = await ctx.app.request('/api/alerts', {
    method: 'POST',
    headers: bobHeaders,
    body: JSON.stringify({
      name: 'shared spike',
      savedQueryId: savedQuery.id,
      columnName: 'count',
      op: '>',
      value: '100',
      cron,
      notifications: { channels: ['slack'] },
    }),
  });
  const alert = alertSchema.parse(await alertResponse.json()) as Alert;
  await ctx.app.request(`/api/saved-queries/${savedQuery.id}/shares`, {
    method: 'PUT',
    headers: aliceHeaders,
    body: JSON.stringify({ shares: [] }),
  });
  return alert;
}

describe('alert routes', () => {
  it('does not manually evaluate a saved query after its share is revoked', async () => {
    const ctx = await createTestContext({
      scenarios: [VALIDATE_OK, QUERY_OK],
      env: { AUTH_MODE: 'proxy' },
      remoteAddress: () => '127.0.0.1',
    });
    const alert = await createAlertForSharedQuery(ctx, '0 * * * *');
    await ctx.services.alerts.update('bob', alert.id, { state: 'triggered' });
    const requestsBeforeEval = ctx.fake.requests.length;

    const response = await ctx.app.request(`/api/alerts/${alert.id}/eval`, {
      method: 'POST',
      headers: bobHeaders,
    });

    expect(response.status).toBe(200);
    expect(alertEvalResponseSchema.parse(await response.json())).toMatchObject({
      previousState: 'triggered',
      state: 'triggered',
      conditionMet: false,
      notified: false,
      errorType: 'SAVED_QUERY_ACCESS_DENIED',
    });
    expect(ctx.fake.requests).toHaveLength(requestsBeforeEval);
    await ctx.services.shutdown();
  });

  it('does not run a cron evaluation after a saved-query share is revoked', async () => {
    let now = Date.parse('2026-07-12T00:00:00.000Z');
    const ctx = await createTestContext({
      scenarios: [VALIDATE_OK, QUERY_OK],
      env: { AUTH_MODE: 'proxy' },
      remoteAddress: () => '127.0.0.1',
      now: () => now,
    });
    const alert = await createAlertForSharedQuery(ctx, '* * * * *');
    await ctx.services.alertEvaluator.tick();
    now += 60_001;
    const requestsBeforeEval = ctx.fake.requests.length;

    await ctx.services.alertEvaluator.tick();
    await ctx.services.alertEvaluator.whenIdle();

    expect(ctx.fake.requests).toHaveLength(requestsBeforeEval);
    expect((await ctx.services.alerts.get('bob', alert.id))?.state).toBe('unknown');
    await ctx.services.shutdown();
  });

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

  it('does not report an evaluator database failure as an evaluation conflict', async () => {
    const ctx = await createTestContext({ scenarios: [VALIDATE_OK, QUERY_OK] });
    const savedQueryResponse = await ctx.app.request('/api/saved-queries', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ name: 'metric', statement: 'SELECT alert_val' }),
    });
    const savedQuery = (await savedQueryResponse.json()) as { id: string };
    const alertResponse = await ctx.app.request('/api/alerts', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        name: 'db-failure',
        savedQueryId: savedQuery.id,
        columnName: 'count',
        op: '>',
        value: '100',
        cron: '0 * * * *',
      }),
    });
    const alert = alertSchema.parse(await alertResponse.json());
    vi.spyOn(ctx.services.alertEvaluator, 'evalManual').mockRejectedValueOnce(
      new Error('database unavailable'),
    );

    const response = await ctx.app.request(`/api/alerts/${alert.id}/eval`, { method: 'POST' });

    expect(response.status).toBe(500);
    expect((await response.json()) as unknown).toMatchObject({ error: { code: 'INTERNAL' } });
    await ctx.services.shutdown();
  });

  it('returns an explicit evaluation error for an invalid numeric result', async () => {
    const ctx = await createTestContext({ scenarios: [VALIDATE_OK, QUERY_INVALID_NUMERIC] });
    const savedQueryResponse = await ctx.app.request('/api/saved-queries', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ name: 'invalid metric', statement: 'SELECT invalid_numeric' }),
    });
    const savedQuery = (await savedQueryResponse.json()) as { id: string };
    const alertResponse = await ctx.app.request('/api/alerts', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        name: 'invalid numeric alert',
        savedQueryId: savedQuery.id,
        columnName: 'count',
        op: '>',
        value: '100',
        cron: '0 * * * *',
      }),
    });
    const alert = alertSchema.parse(await alertResponse.json());

    const response = await ctx.app.request(`/api/alerts/${alert.id}/eval`, { method: 'POST' });

    expect(response.status).toBe(200);
    expect(alertEvalResponseSchema.parse(await response.json())).toMatchObject({
      previousState: 'unknown',
      state: 'unknown',
      conditionMet: false,
      observedValue: null,
      notified: false,
      errorType: 'INVALID_NUMERIC_VALUE',
    });
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

  it('enqueues one pending delivery per channel while anchoring state at evaluation time', async () => {
    const ctx = await createTestContext({
      scenarios: [VALIDATE_OK, QUERY_OK],
      configOverrides: {
        alertDelivery: { intervalMs: 60_000, maxAttempts: 5, backoffMs: 10_000 },
      },
    });
    const sendAlertTriggered = vi.spyOn(ctx.services.notifications, 'sendAlertTriggered');
    const sendChannel = vi.spyOn(ctx.services.notifications, 'sendChannel');
    const sqRes = await ctx.app.request('/api/saved-queries', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ name: 'metric outbox', statement: 'SELECT alert_val' }),
    });
    const sq = (await sqRes.json()) as { id: string };
    const createRes = await ctx.app.request('/api/alerts', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        name: 'outbox spike',
        savedQueryId: sq.id,
        columnName: 'count',
        op: '>',
        value: '100',
        selector: 'first',
        rearm: 0,
        cron: '0 * * * *',
        notifications: {
          channels: ['slack', 'email', 'webhook'],
          emailTo: ['ops@example.com'],
          webhookUrl: 'https://example.com/alert',
        },
      }),
    });
    const created = alertSchema.parse(await createRes.json()) as Alert;

    const firstEval = await ctx.app.request(`/api/alerts/${created.id}/eval`, { method: 'POST' });
    expect(alertEvalResponseSchema.parse(await firstEval.json())).toMatchObject({
      state: 'triggered',
      notified: true,
    });
    const anchored = alertSchema.parse(
      await (await ctx.app.request(`/api/alerts/${created.id}`)).json(),
    );
    const jobs = await ctx.services.alertDeliveries.listForTest();
    expect(jobs.map((job) => job.channel).sort()).toEqual(['email', 'slack', 'webhook']);
    expect(jobs.every((job) => job.status === 'pending' && job.attempts === 0)).toBe(true);
    expect(jobs[0]?.payload).toMatchObject({
      alert: { id: created.id, name: 'outbox spike' },
      outcome: { state: 'triggered', notified: true },
      savedQueryName: 'metric outbox',
      datasourceId: 'trino-default',
    });
    expect(anchored.state).toBe('triggered');
    expect(anchored.lastTriggeredAt).not.toBeNull();
    expect(sendAlertTriggered).not.toHaveBeenCalled();
    expect(sendChannel).not.toHaveBeenCalled();

    const secondEval = await ctx.app.request(`/api/alerts/${created.id}/eval`, { method: 'POST' });
    expect(alertEvalResponseSchema.parse(await secondEval.json()).notified).toBe(false);
    expect(await ctx.services.alertDeliveries.listForTest()).toHaveLength(3);
    const afterSecond = alertSchema.parse(
      await (await ctx.app.request(`/api/alerts/${created.id}`)).json(),
    );
    expect(afterSecond.lastTriggeredAt).toBe(anchored.lastTriggeredAt);

    await ctx.services.shutdown();
  });

  it('rolls back the alert transition when delivery enqueue fails and retries next evaluation', async () => {
    const ctx = await createTestContext({
      scenarios: [VALIDATE_OK, QUERY_OK],
      configOverrides: {
        alertDelivery: { intervalMs: 60_000, maxAttempts: 5, backoffMs: 10_000 },
      },
    });
    const sqRes = await ctx.app.request('/api/saved-queries', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ name: 'transaction metric', statement: 'SELECT alert_val' }),
    });
    const sq = (await sqRes.json()) as { id: string };
    const createRes = await ctx.app.request('/api/alerts', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        name: 'transaction spike',
        savedQueryId: sq.id,
        columnName: 'count',
        op: '>',
        value: '100',
        selector: 'first',
        cron: '0 * * * *',
        notifications: { channels: ['slack', 'email'], emailTo: ['ops@example.com'] },
      }),
    });
    const created = alertSchema.parse(await createRes.json()) as Alert;
    const insertFailure = vi
      .spyOn(AlertDeliveryRepository.prototype, 'insert')
      .mockRejectedValueOnce(new Error('injected delivery failure'));
    try {
      const failedEval = await ctx.app.request(`/api/alerts/${created.id}/eval`, {
        method: 'POST',
      });
      expect(alertEvalResponseSchema.parse(await failedEval.json())).toMatchObject({
        notified: false,
        errorType: 'DELIVERY_ENQUEUE_FAILED',
      });
      const afterFailure = alertSchema.parse(
        await (await ctx.app.request(`/api/alerts/${created.id}`)).json(),
      );
      expect(afterFailure.state).not.toBe('triggered');
      expect(afterFailure.lastTriggeredAt).toBeNull();
      expect(await ctx.services.alertDeliveries.listForTest()).toHaveLength(0);

      insertFailure.mockRestore();
      const retriedEval = await ctx.app.request(`/api/alerts/${created.id}/eval`, {
        method: 'POST',
      });
      expect(alertEvalResponseSchema.parse(await retriedEval.json())).toMatchObject({
        state: 'triggered',
        notified: true,
      });
      expect(await ctx.services.alertDeliveries.listForTest()).toHaveLength(2);
      const afterRetry = alertSchema.parse(
        await (await ctx.app.request(`/api/alerts/${created.id}`)).json(),
      );
      expect(afterRetry.state).toBe('triggered');
      expect(afterRetry.lastTriggeredAt).not.toBeNull();
    } finally {
      insertFailure.mockRestore();
      await ctx.services.shutdown();
    }
  });
});
