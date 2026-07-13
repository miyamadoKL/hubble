/** 永続テーブルの保持期限、ページ削除、live result 参照の保護を実 DB で検証する。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuditRepository } from '../audit';
import type { SqlDatabase } from '../db';
import { dbBackends } from '../test/dbBackends';
import { AlertDeliveryRepository } from '../store/alertDeliveries';
import { HistoryRepository } from '../store/history';
import { DataRetentionService } from './service';

const NOW = Date.parse('2026-07-12T00:00:00.000Z');
const OLD = '2026-05-01T00:00:00.000Z';
const RECENT = '2026-07-01T00:00:00.000Z';

for (const backend of dbBackends) {
  describe(`DataRetentionService on ${backend.name}`, () => {
    let db: SqlDatabase;

    afterEach(async () => {
      if (!db) return;
      if (db.dialect === 'postgres') {
        await db.run('DELETE FROM alert_deliveries');
        await db.run('DELETE FROM query_history');
        await db.run('DELETE FROM audit_log');
      }
      await db.close();
    });

    it('保持期限をページ適用し、pending job と live result 参照を残す', async () => {
      db = await backend.open();
      const alertDeliveries = new AlertDeliveryRepository(db);
      const history = new HistoryRepository(db);
      const audit = new AuditRepository(db, () => new Date(NOW));
      for (const [id, status, updatedAt] of [
        ['ald_old_sent', 'sent', OLD],
        ['ald_old_dead', 'dead', OLD],
        ['ald_old_pending', 'pending', OLD],
        ['ald_recent_sent', 'sent', RECENT],
      ] as const) {
        await db.run(
          `INSERT INTO alert_deliveries
           (id, alert_id, owner, channel, payload, status, attempts, next_attempt_at,
            last_error, created_at, updated_at)
           VALUES (?, 'alt_1', 'alice', 'slack', '{}', ?, 0, ?, NULL, ?, ?)`,
          [id, status, updatedAt, updatedAt, updatedAt],
        );
      }
      for (const [id, submittedAt] of [
        ['qry_old', OLD],
        ['qry_old_live', OLD],
        ['qry_recent', RECENT],
      ] as const) {
        await history.insert({
          id,
          statement: 'SELECT 1',
          state: 'finished',
          owner: 'alice',
          datasourceId: 'trino-default',
          submittedAt,
        });
      }
      await history.setResultObject(
        'qry_old_live',
        'hubble-results/live.jsonl.gz',
        '2027-01-01T00:00:00.000Z',
        { state: 'finished', rowCount: 0, elapsedMs: 0 },
        [],
        'jsonl.gz',
      );
      await audit.record({ actor: 'alice', action: 'query.execute', createdAt: OLD });
      await audit.record({ actor: 'alice', action: 'query.execute', createdAt: RECENT });

      const service = new DataRetentionService({
        alertDeliveries,
        history,
        audit,
        policy: {
          alertDeliveryDays: 30,
          queryHistoryDays: 30,
          auditLogDays: 30,
          batchSize: 1,
        },
        now: () => NOW,
      });
      await service.runOnce();

      expect(
        (await db.query<{ id: string }>('SELECT id FROM alert_deliveries ORDER BY id ASC')).map(
          (row) => row.id,
        ),
      ).toEqual(['ald_old_pending', 'ald_recent_sent']);
      expect(
        (await db.query<{ id: string }>('SELECT id FROM query_history ORDER BY id ASC')).map(
          (row) => row.id,
        ),
      ).toEqual(['qry_old_live', 'qry_recent']);
      expect(await audit.listForTest()).toEqual([
        expect.objectContaining({ actor: 'alice', createdAt: RECENT }),
      ]);
    });
  });
}

it('保持日数が0の対象は自動削除しない', async () => {
  const alertDeliveries = { pruneTerminalBefore: vi.fn() } as unknown as AlertDeliveryRepository;
  const history = { pruneBefore: vi.fn() } as unknown as HistoryRepository;
  const audit = { pruneBefore: vi.fn() } as unknown as AuditRepository;
  const service = new DataRetentionService({
    alertDeliveries,
    history,
    audit,
    policy: { alertDeliveryDays: 0, queryHistoryDays: 0, auditLogDays: 0, batchSize: 1 },
    now: () => NOW,
  });

  await service.runOnce();

  expect(alertDeliveries.pruneTerminalBefore).not.toHaveBeenCalled();
  expect(history.pruneBefore).not.toHaveBeenCalled();
  expect(audit.pruneBefore).not.toHaveBeenCalled();
});
