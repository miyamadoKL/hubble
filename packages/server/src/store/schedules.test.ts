/**
 * `ScheduleRepository` / `ScheduleRunRepository`（packages/server/src/store/schedules.ts）
 * の振る舞いを検証するテストスイート。dbBackends（SQLite 常時、
 * TEST_DATABASE_URL 設定時は PostgreSQL も追加）でパラメタライズし、両方言で
 * 同じ SQL が同じ結果になることを保証する。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SqlDatabase } from '../db/sqlDatabase';
import { dbBackends } from '../test/dbBackends';
import { DEFAULT_DATASOURCE_ID } from '../test/testEngine';
import { ScheduleRepository, ScheduleRunRepository } from './schedules';

const ds = { datasourceId: DEFAULT_DATASOURCE_ID };

/**
 * Schedule + schedule-run repository suite, parameterized over every available
 * backend (SQLite always; PostgreSQL when TEST_DATABASE_URL is set). Verifies
 * CRUD, owner scoping, app-side cascade delete, run recording, and retention
 * pruning behave identically on both dialects.
 */
for (const backend of dbBackends) {
  describe(`schedule repositories on ${backend.name}`, () => {
    let db: SqlDatabase;

    afterEach(async () => {
      vi.restoreAllMocks();
      if (db) {
        // pg backends persist across cases; clean the new tables explicitly.
        // PostgreSQL バックエンドはケース間で状態が持ち越されるため、
        // 明示的に schedules / schedule_runs をクリアしてから閉じる。
        if (db.dialect === 'postgres') {
          await db.run('DELETE FROM schedule_runs');
          await db.run('DELETE FROM schedules');
        }
        await db.close();
      }
    });

    async function open(): Promise<SqlDatabase> {
      db = await backend.open();
      return db;
    }

    describe('ScheduleRepository', () => {
      // 作成→一覧→取得→更新（null クリア含む）→削除の一連のライフサイクルと、
      // owner による隔離（他 owner からは見えない/操作できない）を検証する。
      it('creates, lists, gets, updates, deletes; owner-scoped', async () => {
        const repo = new ScheduleRepository(await open());

        const created = await repo.create('alice', {
          name: 'nightly',
          statement: 'SELECT 1',
          cron: '0 0 * * *',
          catalog: 'tpch',
          schema: 'tiny',
          ...ds,
        });
        expect(created.datasourceId).toBe(DEFAULT_DATASOURCE_ID);
        expect(created.id).toMatch(/^sch_/);
        expect(created.enabled).toBe(true);
        expect(created.retry).toEqual({
          maxAttempts: 3,
          backoffSeconds: 60,
          backoffMultiplier: 2,
        });

        // Owner isolation.
        expect(await repo.list('bob')).toEqual([]);
        expect(await repo.get('bob', created.id)).toBeUndefined();

        const list = await repo.list('alice');
        expect(list).toHaveLength(1);
        expect(list[0]!.catalog).toBe('tpch');

        const updated = await repo.update('alice', created.id, {
          enabled: false,
          cron: '*/5 * * * *',
          retry: { maxAttempts: 5, backoffSeconds: 30, backoffMultiplier: 3 },
        });
        expect(updated?.enabled).toBe(false);
        expect(updated?.cron).toBe('*/5 * * * *');
        expect(updated?.retry.maxAttempts).toBe(5);
        // Untouched fields persist.
        expect(updated?.name).toBe('nightly');

        // Nulling out catalog/schema.
        const nulled = await repo.update('alice', created.id, { catalog: null, schema: null });
        expect(nulled?.catalog).toBeNull();
        expect(nulled?.schema).toBeNull();

        expect(await repo.delete('bob', created.id)).toBe(false);
        expect(await repo.delete('alice', created.id)).toBe(true);
        expect(await repo.get('alice', created.id)).toBeUndefined();
      });

      // listAllEnabled() が owner を横断して enabled=true のスケジュールのみを
      // 返すこと（スケジューラーが使う想定の挙動）を検証する。
      it('lists only enabled schedules across owners for the scheduler', async () => {
        const repo = new ScheduleRepository(await open());
        await repo.create('alice', { name: 'on', statement: 'SELECT 1', cron: '* * * * *', ...ds });
        await repo.create('bob', {
          name: 'off',
          statement: 'SELECT 2',
          cron: '* * * * *',
          enabled: false,
          ...ds,
        });
        await repo.create('carol', {
          name: 'on2',
          statement: 'SELECT 3',
          cron: '* * * * *',
          ...ds,
        });

        const enabled = await repo.listAllEnabled();
        expect(enabled.map((s) => s.name).sort()).toEqual(['on', 'on2']);
      });

      // スケジュール削除時に、そのスケジュールに紐づく実行履歴（schedule_runs）も
      // アプリ側カスケードで一緒に削除されることを検証する。
      it('cascade-deletes runs when a schedule is removed', async () => {
        const db2 = await open();
        const repo = new ScheduleRepository(db2);
        const runs = new ScheduleRunRepository(db2, 50);
        const s = await repo.create('alice', {
          name: 's',
          statement: 'SELECT 1',
          cron: '* * * * *',
          ...ds,
        });
        const runId = await runs.start({
          scheduleId: s.id,
          owner: 'alice',
          scheduledFor: '2026-01-01T00:00:00.000Z',
          startedAt: '2026-01-01T00:00:00.000Z',
        });
        await runs.finish(runId, s.id, {
          status: 'success',
          attempt: 1,
          rowCount: 1,
          elapsedMs: 5,
          finishedAt: '2026-01-01T00:00:01.000Z',
        });
        expect(await runs.list(s.id, 10)).toHaveLength(1);

        await repo.delete('alice', s.id);
        expect(await runs.list(s.id, 10)).toHaveLength(0);
      });

      it('persists datasource_id from create input', async () => {
        const repo = new ScheduleRepository(await open());
        const created = await repo.create('alice', {
          name: 'ds-test',
          statement: 'SELECT 1',
          cron: '0 0 * * *',
          datasourceId: 'custom-trino',
        });
        expect(created.datasourceId).toBe('custom-trino');
        const fetched = await repo.get('alice', created.id);
        expect(fetched?.datasourceId).toBe('custom-trino');
      });

      it('warns when a stored principal snapshot is not valid JSON', async () => {
        const db2 = await open();
        const repo = new ScheduleRepository(db2);
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const created = await repo.create('alice', {
          name: 'bad-json-principal',
          statement: 'SELECT 1',
          cron: '0 0 * * *',
          ...ds,
        });
        await db2.run('UPDATE schedules SET principal_snapshot = ? WHERE id = ?', [
          '{not-json',
          created.id,
        ]);

        const fetched = await repo.get('alice', created.id);

        expect(fetched?.principalSnapshot).toBeNull();
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith(
          `schedule principal_snapshot ignored: schedule_id=${created.id} reason=json-parse`,
        );
      });

      it('warns when a stored principal snapshot fails schema validation', async () => {
        const db2 = await open();
        const repo = new ScheduleRepository(db2);
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const created = await repo.create('alice', {
          name: 'bad-shape-principal',
          statement: 'SELECT 1',
          cron: '0 0 * * *',
          ...ds,
        });
        await db2.run('UPDATE schedules SET principal_snapshot = ? WHERE id = ?', [
          JSON.stringify({ user: '' }),
          created.id,
        ]);

        const fetched = await repo.get('alice', created.id);

        expect(fetched?.principalSnapshot).toBeNull();
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith(
          `schedule principal_snapshot ignored: schedule_id=${created.id} reason=schema-validate`,
        );
      });
    });

    describe('ScheduleRunRepository', () => {
      // start→finish で状態が running→終端に遷移すること、list() が
      // 新しい順に並ぶこと、abortOrphans() が running のまま残った行を
      // aborted にすることを検証する。
      it('records, lists newest-first, reports running, and aborts orphans', async () => {
        const db2 = await open();
        const repo = new ScheduleRepository(db2);
        const runs = new ScheduleRunRepository(db2, 50);
        const s = await repo.create('alice', {
          name: 's',
          statement: 'SELECT 1',
          cron: '* * * * *',
          ...ds,
        });

        const r1 = await runs.start({
          scheduleId: s.id,
          owner: 'alice',
          scheduledFor: '2026-01-01T00:00:00.000Z',
          startedAt: '2026-01-01T00:00:00.000Z',
        });
        expect(await runs.hasRunning(s.id)).toBe(true);
        await runs.finish(r1, s.id, {
          status: 'success',
          attempt: 1,
          trinoQueryId: 'q1',
          rowCount: 7,
          elapsedMs: 12,
          finishedAt: '2026-01-01T00:00:01.000Z',
        });
        expect(await runs.hasRunning(s.id)).toBe(false);

        const r2 = await runs.start({
          scheduleId: s.id,
          owner: 'alice',
          scheduledFor: '2026-01-01T00:01:00.000Z',
          startedAt: '2026-01-01T00:01:00.000Z',
        });

        const list = await runs.list(s.id, 10);
        // Newest first.
        expect(list[0]!.id).toBe(r2);
        expect(list[1]!.id).toBe(r1);
        expect(list[1]!.status).toBe('success');
        expect(list[1]!.rowCount).toBe(7);
        expect(list[1]!.trinoQueryId).toBe('q1');

        const latest = await runs.latest(s.id);
        expect(latest?.id).toBe(r2);

        // Crash recovery: the still-running r2 is aborted.
        const aborted = await runs.abortOrphans('2026-01-01T00:02:00.000Z');
        expect(aborted).toBe(1);
        const after = await runs.list(s.id, 10);
        expect(after.find((r) => r.id === r2)?.status).toBe('aborted');
      });

      // retention（保持上限）を超えた古い実行履歴が自動的に間引かれ、
      // 常に最新 N 件だけが残ることを検証する。
      it('prunes to the retention cap per schedule', async () => {
        const db2 = await open();
        const repo = new ScheduleRepository(db2);
        const runs = new ScheduleRunRepository(db2, 3); // keep only 3
        const s = await repo.create('alice', {
          name: 's',
          statement: 'SELECT 1',
          cron: '* * * * *',
          ...ds,
        });

        for (let i = 0; i < 6; i++) {
          const minute = String(i).padStart(2, '0');
          const ts = `2026-01-01T00:${minute}:00.000Z`;
          const id = await runs.start({
            scheduleId: s.id,
            owner: 'alice',
            scheduledFor: ts,
            startedAt: ts,
          });
          await runs.finish(id, s.id, {
            status: 'success',
            attempt: 1,
            rowCount: i,
            elapsedMs: 1,
            finishedAt: ts,
          });
        }

        const kept = await runs.list(s.id, 100);
        expect(kept).toHaveLength(3);
        // The three newest (minutes 03, 04, 05) survive.
        expect(kept.map((r) => r.rowCount).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([3, 4, 5]);
      });
    });
  });
}
