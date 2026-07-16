import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { openMemoryDatabase } from '../db';
import { openTestDatabase } from '../test/dbBackends';
import { AuditLogger, AuditRepository } from './index';

describe('AuditLogger', () => {
  it('logs and swallows repository failures', async () => {
    const err = new Error('db down');
    const logError = vi.fn();
    const logger = new AuditLogger(
      {
        record: async () => {
          throw err;
        },
        listForTest: async () => [],
      },
      logError,
    );

    await expect(
      logger.record({
        actor: 'alice',
        action: 'query.execute',
        target: 'q_1',
        datasource: 'trino-default',
        detail: {},
      }),
    ).resolves.toBeUndefined();
    expect(logError).toHaveBeenCalledWith('audit log write failed; continuing request', err);
  });

  it('writes and reads audit_log through better-sqlite3', async () => {
    expect(typeof Database).toBe('function');
    const db = await openMemoryDatabase();
    try {
      const repo = new AuditRepository(db, () => new Date('2026-01-01T00:00:00.000Z'));
      const id = await repo.record({
        actor: 'alice',
        action: 'csv.download',
        target: 'q_1',
        datasource: 'trino-default',
        detail: { outcome: 'allowed', rowCount: 3 },
      });

      const rows = await repo.listForTest();
      expect(rows).toEqual([
        {
          id,
          actor: 'alice',
          action: 'csv.download',
          target: 'q_1',
          datasource: 'trino-default',
          detail: { outcome: 'allowed', rowCount: 3 },
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ]);
    } finally {
      await db.close();
    }
  });

  it('searches with filters and a stable compound cursor', async () => {
    const db = await openTestDatabase();
    try {
      const repo = new AuditRepository(db);
      await repo.record({
        actor: 'alice',
        action: 'query.execute',
        datasource: 'trino-default',
        createdAt: '2026-01-03T00:00:00.000Z',
      });
      await repo.record({
        actor: 'alice',
        action: 'query.kill',
        datasource: 'trino-default',
        createdAt: '2026-01-02T00:00:00.000Z',
      });
      await repo.record({
        actor: 'bob',
        action: 'query.execute',
        datasource: 'mysql',
        createdAt: '2026-01-01T00:00:00.000Z',
      });

      const first = await repo.search({ actor: 'alice', limit: 1 });
      expect(first.items).toHaveLength(1);
      expect(first.items[0]?.action).toBe('query.execute');
      expect(first.nextCursor).toBeDefined();
      const second = await repo.search({ actor: 'alice', limit: 1, cursor: first.nextCursor });
      expect(second.items.map((row) => row.action)).toEqual(['query.kill']);
      expect(second.nextCursor).toBeUndefined();
    } finally {
      await db.close();
    }
  });
});
