import { describe, expect, it } from 'vitest';
import type { AlertTriggeredNotificationInput } from '../notification/service';
import { dbBackends } from '../test/dbBackends';
import { AlertDeliveryRepository } from './alertDeliveries';

function payload(): AlertTriggeredNotificationInput {
  return {
    alert: {
      id: 'alt_delivery',
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
      notifications: { channels: ['slack'] },
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

describe.each(dbBackends)('AlertDeliveryRepository ($name)', ({ open }) => {
  it('claims only due pending jobs and preserves retry, sent, and dead states', async () => {
    const db = await open();
    await db.run('DELETE FROM alert_deliveries');
    const repository = new AlertDeliveryRepository(db);
    const dueAt = '2026-01-01T00:00:00.000Z';
    const futureAt = '2026-01-01T00:10:00.000Z';
    const dueId = await repository.insert({
      alertId: 'alt_delivery',
      owner: 'alice',
      channel: 'slack',
      payload: payload(),
      nextAttemptAt: dueAt,
    });
    const futureId = await repository.insert({
      alertId: 'alt_delivery',
      owner: 'alice',
      channel: 'email',
      payload: payload(),
      nextAttemptAt: futureAt,
    });

    expect((await repository.claimDue(dueAt, 10)).map((job) => job.id)).toEqual([dueId]);
    await repository.markRetry(dueId, 1, '2026-01-01T00:01:00.000Z', 'temporary failure', dueAt);
    expect(await repository.claimDue(dueAt, 10)).toEqual([]);
    await repository.markSent(dueId, '2026-01-01T00:01:00.000Z');
    await repository.markDead(futureId, 3, 'permanent failure', futureAt);

    expect(await repository.claimDue('2027-01-01T00:00:00.000Z', 10)).toEqual([]);
    const jobs = await repository.listForTest();
    expect(jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: dueId,
          status: 'sent',
          attempts: 1,
          lastError: null,
          payload: expect.objectContaining({ savedQueryName: 'row count' }),
        }),
        expect.objectContaining({
          id: futureId,
          status: 'dead',
          attempts: 3,
          lastError: 'permanent failure',
        }),
      ]),
    );
    await db.close();
  });
});
