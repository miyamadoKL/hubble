import { describe, expect, it, vi } from 'vitest';
import type { AlertTriggeredNotificationInput } from '../notification/service';
import { openMemoryDatabase } from '../db';
import { AlertDeliveryRepository } from '../store/alertDeliveries';
import { AlertDeliveryWorker } from './deliveryWorker';

function payload(): AlertTriggeredNotificationInput {
  return {
    alert: {
      id: 'alt_worker',
      owner: 'alice',
      name: 'high rows',
      savedQueryId: 'sq_1',
      columnName: 'row_count',
      op: '>',
      value: '100',
      selector: 'first',
      rearm: 0,
      muted: false,
      cron: '* * * * *',
      state: 'unknown',
      lastTriggeredAt: null,
      notifications: { channels: ['slack', 'email'], emailTo: ['ops@example.com'] },
      principalSnapshot: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    outcome: {
      previousState: 'unknown',
      state: 'triggered',
      conditionMet: true,
      observedValue: '101',
      notified: true,
      errorType: null,
      errorMessage: null,
    },
    savedQueryName: 'row count',
    datasourceId: 'trino-default',
    evaluatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('AlertDeliveryWorker', () => {
  it('marks success sent, retries failures with backoff, then moves them to dead', async () => {
    const db = await openMemoryDatabase();
    const deliveries = new AlertDeliveryRepository(db);
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const dueAt = new Date(now).toISOString();
    await deliveries.insert({
      alertId: 'alt_worker',
      owner: 'alice',
      channel: 'slack',
      payload: payload(),
      nextAttemptAt: dueAt,
    });
    await deliveries.insert({
      alertId: 'alt_worker',
      owner: 'alice',
      channel: 'email',
      payload: payload(),
      nextAttemptAt: dueAt,
    });
    const sendChannel = vi.fn(async (channel: 'slack' | 'email' | 'webhook') => {
      if (channel === 'email') throw new Error('Email send timed out');
    });
    const logWarn = vi.fn();
    const worker = new AlertDeliveryWorker({
      deliveries,
      notifications: { sendChannel },
      config: { intervalMs: 5_000, maxAttempts: 2, backoffMs: 1_000 },
      now: () => now,
      logWarn,
    });

    await worker.tick();
    let jobs = await deliveries.listForTest();
    expect(jobs.find((job) => job.channel === 'slack')).toMatchObject({ status: 'sent' });
    expect(jobs.find((job) => job.channel === 'email')).toMatchObject({
      status: 'pending',
      attempts: 1,
      nextAttemptAt: '2026-01-01T00:00:01.000Z',
      lastError: 'Email send timed out',
    });

    await worker.tick();
    expect(sendChannel).toHaveBeenCalledTimes(2);
    now += 1_000;
    await worker.tick();
    jobs = await deliveries.listForTest();
    expect(jobs.find((job) => job.channel === 'email')).toMatchObject({
      status: 'dead',
      attempts: 2,
      lastError: 'Email send timed out',
    });
    expect(logWarn).toHaveBeenCalledOnce();

    now += 60_000;
    await worker.tick();
    expect(sendChannel).toHaveBeenCalledTimes(3);
    await db.close();
  });
});
