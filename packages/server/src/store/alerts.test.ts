/**
 * `AlertRepository` の振る舞いを検証するテスト。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SqlDatabase } from '../db/sqlDatabase';
import { openTestDatabase } from '../test/dbBackends';
import { AlertRepository } from './alerts';

describe('AlertRepository', () => {
  let db: SqlDatabase;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (db) {
      await db.run('DELETE FROM alerts');
      await db.close();
    }
  });

  async function open(): Promise<SqlDatabase> {
    db = await openTestDatabase();
    return db;
  }

  it('creates, lists, gets, updates, deletes; owner-scoped', async () => {
    const repo = new AlertRepository(await open());
    const created = await repo.create('alice', {
      name: 'High error rate',
      savedQueryId: 'sq_test',
      columnName: 'count',
      op: '>',
      value: '100',
      selector: 'max',
      cron: '*/5 * * * *',
      notifications: { channels: ['slack'] },

      principalSnapshot: { user: 'alice' },
    });
    expect(created.id).toMatch(/^alt_/);
    expect(created.state).toBe('unknown');
    expect(created.muted).toBe(false);

    expect(await repo.list('bob')).toEqual([]);
    expect(await repo.get('bob', created.id)).toBeUndefined();

    const updated = await repo.update('alice', created.id, {
      muted: true,
      state: 'triggered',
      lastTriggeredAt: '2026-01-01T00:00:00.000Z',
    });
    expect(updated?.muted).toBe(true);
    expect(updated?.state).toBe('triggered');

    expect(await repo.delete('alice', created.id)).toBe(true);
    expect(await repo.list('alice')).toEqual([]);
  });

  it('listAllUnmuted excludes muted alerts', async () => {
    const repo = new AlertRepository(await open());
    await repo.create('alice', {
      name: 'active',
      savedQueryId: 'sq_1',
      columnName: 'v',
      op: '>',
      value: '1',
      cron: '* * * * *',

      principalSnapshot: { user: 'alice' },
    });
    const muted = await repo.create('alice', {
      name: 'muted',
      savedQueryId: 'sq_2',
      columnName: 'v',
      op: '>',
      value: '1',
      cron: '* * * * *',
      muted: true,

      principalSnapshot: { user: 'alice' },
    });
    const active = await repo.listAllUnmuted();
    expect(active.map((a) => a.id)).not.toContain(muted.id);
    expect(active).toHaveLength(1);
  });
});
