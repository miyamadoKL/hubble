import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { openMemoryDatabase } from '../db';
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
});
