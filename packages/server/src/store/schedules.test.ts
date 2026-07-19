/**
 * `ScheduleRepository` / `ScheduleRunRepository`（packages/server/src/store/schedules.ts）
 * の振る舞いを検証するテストスイート。PostgreSQLのワーカー用スキーマを使い、
 * CRUD、所有者分離、カスケード、実行履歴の結果を検証する。
 * schedule は常に savedQueryId 参照のみを持ち、statement/catalog/schema/datasourceId は
 * 保持しない（それらは参照先の saved query が持つ値を実行のたびに解決する）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SqlDatabase } from '../db/sqlDatabase';
import { openTestDatabase } from '../test/dbBackends';
import {
  ScheduleRepository,
  ScheduleRunClaimConflictError,
  ScheduleRunRepository,
} from './schedules';

/**
 * Schedule + schedule-run repository suite. CRUD、owner分離、アプリ側の
 * カスケード削除、実行記録、保持期限削除を検証する。
 */
describe('schedule repositories', () => {
  let db: SqlDatabase;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (db) {
      // PostgreSQLのワーカー用スキーマはケース間で状態が持ち越されるため、明示的に消去する。
      await db.run('DELETE FROM schedule_runs');
      await db.run('DELETE FROM schedules');
      await db.close();
    }
  });

  async function open(): Promise<SqlDatabase> {
    db = await openTestDatabase();
    return db;
  }

  describe('ScheduleRepository', () => {
    // 作成→一覧→取得→更新→削除の一連のライフサイクルと、所有者による隔離
    // （他の所有者からは見えない、操作できない）を検証する。
    it('creates, lists, gets, updates, deletes; owner-scoped', async () => {
      const repo = new ScheduleRepository(await open());

      const created = await repo.create('alice', {
        name: 'nightly',
        savedQueryId: 'sq_1',
        cron: '0 0 * * *',
        principalSnapshot: { user: 'alice' },
      });
      expect(created.savedQueryId).toBe('sq_1');
      expect(created.id).toMatch(/^sch_/);
      expect(created.enabled).toBe(true);
      expect(created.retry).toEqual({
        maxAttempts: 3,
        backoffSeconds: 60,
        backoffMultiplier: 2,
      });

      // 所有者による隔離を確認する。
      expect(await repo.list('bob')).toEqual([]);
      expect(await repo.get('bob', created.id)).toBeUndefined();

      const list = await repo.list('alice');
      expect(list).toHaveLength(1);
      expect(list[0]!.savedQueryId).toBe('sq_1');

      const updated = await repo.update('alice', created.id, {
        enabled: false,
        cron: '*/5 * * * *',
        retry: { maxAttempts: 5, backoffSeconds: 30, backoffMultiplier: 3 },
      });
      expect(updated?.enabled).toBe(false);
      expect(updated?.cron).toBe('*/5 * * * *');
      expect(updated?.retry.maxAttempts).toBe(5);
      // 更新対象外のフィールドが維持されることを確認する。
      expect(updated?.name).toBe('nightly');

      // savedQueryId を切り替えられることを確認する。
      const switched = await repo.update('alice', created.id, { savedQueryId: 'sq_2' });
      expect(switched?.savedQueryId).toBe('sq_2');

      expect(await repo.delete('bob', created.id)).toBe(false);
      expect(await repo.delete('alice', created.id)).toBe(true);
      expect(await repo.get('alice', created.id)).toBeUndefined();
    });

    // saved_query_id は NOT NULL 制約が付いている
    // (migrations/0003_schedule_saved_query_only.sql)。repository/契約層を経由しない
    // 直接の INSERT でも拒否されることを、生 SQL で確認する。
    it('rejects a null saved_query_id at the DB level (NOT NULL constraint)', async () => {
      const database = await open();
      const nowIso = new Date().toISOString();
      await expect(
        database.run(
          `INSERT INTO schedules
             (id, owner, name, saved_query_id, cron, enabled,
              retry_max_attempts, retry_backoff_seconds, retry_backoff_multiplier,
              notifications, principal_snapshot, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            'sch_check_test',
            'alice',
            'null-saved-query',
            null, // saved_query_id が NULL → NOT NULL 制約違反
            '* * * * *',
            1,
            3,
            60,
            2,
            '{}',
            null,
            nowIso,
            nowIso,
          ],
        ),
      ).rejects.toThrow();
    });

    // listAllEnabled() が所有者を横断して enabled=true のスケジュールのみを
    // 返すこと（スケジューラーが使う想定の挙動）を検証する。
    it('lists only enabled schedules across owners for the scheduler', async () => {
      const repo = new ScheduleRepository(await open());
      await repo.create('alice', {
        name: 'on',
        savedQueryId: 'sq_1',
        cron: '* * * * *',
        principalSnapshot: { user: 'alice' },
      });
      await repo.create('bob', {
        name: 'off',
        savedQueryId: 'sq_2',
        cron: '* * * * *',
        enabled: false,
        principalSnapshot: { user: 'bob' },
      });
      await repo.create('carol', {
        name: 'on2',
        savedQueryId: 'sq_3',
        cron: '* * * * *',
        principalSnapshot: { user: 'carol' },
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
        savedQueryId: 'sq_1',
        cron: '* * * * *',
        principalSnapshot: { user: 'alice' },
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

    it('run削除が失敗したらschedule削除もrollbackする', async () => {
      const db2 = await open();
      const repo = new ScheduleRepository(db2);
      const runs = new ScheduleRunRepository(db2, 50);
      const schedule = await repo.create('alice', {
        name: 'rollback',
        savedQueryId: 'sq_1',
        cron: '* * * * *',
        principalSnapshot: { user: 'alice' },
      });
      await runs.start({
        scheduleId: schedule.id,
        owner: 'alice',
        scheduledFor: '2026-01-01T00:00:00.000Z',
        startedAt: '2026-01-01T00:00:00.000Z',
      });
      await db2.exec(`
          CREATE OR REPLACE FUNCTION reject_schedule_run_delete() RETURNS trigger
          LANGUAGE plpgsql AS $$
          BEGIN
            RAISE EXCEPTION 'run delete failed';
          END;
          $$;
          CREATE TRIGGER reject_schedule_run_delete
          BEFORE DELETE ON schedule_runs
          FOR EACH ROW EXECUTE FUNCTION reject_schedule_run_delete();
        `);

      try {
        await expect(repo.delete('alice', schedule.id)).rejects.toThrow('run delete failed');

        expect(await repo.get('alice', schedule.id)).toBeDefined();
        expect(await runs.list(schedule.id, 10)).toHaveLength(1);
      } finally {
        await db2.exec(`
            DROP TRIGGER IF EXISTS reject_schedule_run_delete ON schedule_runs;
            DROP FUNCTION IF EXISTS reject_schedule_run_delete();
          `);
      }
    });

    it('warns when a stored principal snapshot is not valid JSON', async () => {
      const db2 = await open();
      const repo = new ScheduleRepository(db2);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const created = await repo.create('alice', {
        name: 'bad-json-principal',
        savedQueryId: 'sq_1',
        cron: '0 0 * * *',
        principalSnapshot: { user: 'alice' },
      });
      await db2.run('UPDATE schedules SET principal_snapshot = $1 WHERE id = $2', [
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
        savedQueryId: 'sq_1',
        cron: '0 0 * * *',
        principalSnapshot: { user: 'alice' },
      });
      await db2.run('UPDATE schedules SET principal_snapshot = $1 WHERE id = $2', [
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
    it('atomically claims one running row for concurrent requests', async () => {
      const db2 = await open();
      const schedules = new ScheduleRepository(db2);
      const runs = new ScheduleRunRepository(db2, 50);
      const schedule = await schedules.create('alice', {
        name: 'claim',
        savedQueryId: 'sq_1',
        cron: '* * * * *',
        principalSnapshot: { user: 'alice' },
      });
      const input = {
        scheduleId: schedule.id,
        owner: 'alice',
        scheduledFor: '2026-01-01T00:00:00.000Z',
        startedAt: '2026-01-01T00:00:00.000Z',
      };

      const claims = await Promise.allSettled([runs.start(input), runs.start(input)]);
      expect(claims.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(claims.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect(claims.find((result) => result.status === 'rejected')).toMatchObject({
        reason: expect.any(ScheduleRunClaimConflictError),
      });
      expect(await runs.list(schedule.id, 10)).toHaveLength(1);
    });

    // start→finish で状態が running→終端に遷移すること、list() が
    // 新しい順に並ぶこと、abortOrphans() が running のまま残った行を
    // aborted にすることを検証する。
    it('records, lists newest-first, reports running, and aborts orphans', async () => {
      const db2 = await open();
      const repo = new ScheduleRepository(db2);
      const runs = new ScheduleRunRepository(db2, 50);
      const s = await repo.create('alice', {
        name: 's',
        savedQueryId: 'sq_1',
        cron: '* * * * *',
        principalSnapshot: { user: 'alice' },
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
      // 新しい実行履歴が先に並ぶことを確認する。
      expect(list[0]!.id).toBe(r2);
      expect(list[1]!.id).toBe(r1);
      expect(list[1]!.status).toBe('success');
      expect(list[1]!.rowCount).toBe(7);
      expect(list[1]!.trinoQueryId).toBe('q1');

      const latest = await runs.latest(s.id);
      expect(latest?.id).toBe(r2);

      // 障害復旧として、実行中のr2を中止することを確認する。
      const aborted = await runs.abortOrphans('2026-01-01T00:02:00.000Z');
      expect(aborted).toBe(1);
      const after = await runs.list(s.id, 10);
      expect(after.find((r) => r.id === r2)?.status).toBe('aborted');
    });

    it('複数スケジュールの直近 run を1クエリで取得する', async () => {
      const db2 = await open();
      const schedules = new ScheduleRepository(db2);
      const runs = new ScheduleRunRepository(db2, 50);
      const first = await schedules.create('alice', {
        name: 'first',
        savedQueryId: 'sq_1',
        cron: '* * * * *',
        principalSnapshot: { user: 'alice' },
      });
      const second = await schedules.create('alice', {
        name: 'second',
        savedQueryId: 'sq_2',
        cron: '* * * * *',
        principalSnapshot: { user: 'alice' },
      });
      const firstRun = await runs.start({
        scheduleId: first.id,
        owner: 'alice',
        scheduledFor: '2026-01-01T00:00:00.000Z',
        startedAt: '2026-01-01T00:00:00.000Z',
      });
      const secondRun = await runs.start({
        scheduleId: second.id,
        owner: 'alice',
        scheduledFor: '2026-01-01T00:01:00.000Z',
        startedAt: '2026-01-01T00:01:00.000Z',
      });
      const query = vi.spyOn(db2, 'query');
      query.mockClear();

      const latest = await runs.latestMany([first.id, second.id]);

      expect(query).toHaveBeenCalledTimes(1);
      expect(latest.get(first.id)?.id).toBe(firstRun);
      expect(latest.get(second.id)?.id).toBe(secondRun);
    });

    it('1000件超の直近 run 検索を500 idずつに分割する', async () => {
      const db2 = await open();
      const runs = new ScheduleRunRepository(db2, 50);
      const query = vi.spyOn(db2, 'query');

      const latest = await runs.latestMany(
        Array.from({ length: 1_001 }, (_, index) => `sch_${index}`),
      );

      expect(latest.size).toBe(0);
      expect(query).toHaveBeenCalledTimes(3);
      expect(query.mock.calls.map((call) => call[1]?.length)).toEqual([500, 500, 1]);
    });

    // retention（保持上限）を超えた古い実行履歴が自動的に間引かれ、
    // 常に最新 N 件だけが残ることを検証する。
    it('prunes to the retention cap per schedule', async () => {
      const db2 = await open();
      const repo = new ScheduleRepository(db2);
      const runs = new ScheduleRunRepository(db2, 3); // keep only 3
      const s = await repo.create('alice', {
        name: 's',
        savedQueryId: 'sq_1',
        cron: '* * * * *',
        principalSnapshot: { user: 'alice' },
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
      // 最新の3件（03分、04分、05分）が残ることを確認する。
      expect(kept.map((r) => r.rowCount).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([3, 4, 5]);
    });
  });
});
