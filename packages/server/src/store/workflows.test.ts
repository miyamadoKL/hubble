/**
 * WorkflowRepository / WorkflowRunRepository の振る舞いを dbBackends で検証する。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SqlDatabase, SqlParam } from '../db/sqlDatabase';
import { workflowDefinitionSchema } from '@hubble/contracts';
import { dbBackends } from '../test/dbBackends';
import { DEFAULT_DATASOURCE_ID } from '../test/testEngine';
import { ResultObjectDeletionRepository } from './resultObjectDeletions';
import {
  WorkflowRepository,
  WorkflowRunClaimConflictError,
  WorkflowRunRepository,
  WorkflowRunTargetNotFoundError,
} from './workflows';

const ds = { datasourceId: DEFAULT_DATASOURCE_ID };

const sampleStages = workflowDefinitionSchema.parse([
  {
    steps: [
      { id: 'st_a', name: 'A', statement: 'SELECT 1' },
      { id: 'st_b', name: 'B', statement: 'SELECT 2' },
    ],
  },
  {
    steps: [{ id: 'st_c', name: 'C', statement: 'SELECT 3' }],
  },
]);

function failAfterResultObjectDeletionInsert(database: SqlDatabase): SqlDatabase {
  const wrap = (handle: SqlDatabase): SqlDatabase => ({
    dialect: handle.dialect,
    query: <T>(sql: string, params?: readonly SqlParam[]) => handle.query<T>(sql, params),
    run: async (sql, params) => {
      await handle.run(sql, params);
      if (sql.includes('INSERT INTO result_object_deletions')) {
        throw new Error('outbox unavailable');
      }
    },
    exec: (sql) => handle.exec(sql),
    transaction: <T>(fn: (tx: SqlDatabase) => Promise<T>) =>
      handle.transaction((tx) => fn(wrap(tx))),
    close: () => handle.close(),
  });
  return wrap(database);
}

for (const backend of dbBackends) {
  describe(`workflow repositories on ${backend.name}`, () => {
    let db: SqlDatabase;

    afterEach(async () => {
      if (db) {
        if (db.dialect === 'postgres') {
          await db.run('DELETE FROM result_object_deletions');
          await db.run('DELETE FROM workflow_step_runs');
          await db.run('DELETE FROM workflow_runs');
          await db.run('DELETE FROM workflows');
        }
        await db.close();
      }
    });

    async function open(): Promise<SqlDatabase> {
      db = await backend.open();
      return db;
    }

    describe('WorkflowRepository', () => {
      it('creates, lists, gets, updates, deletes with owner scope', async () => {
        const repo = new WorkflowRepository(await open());
        const created = await repo.create('alice', {
          name: 'pipeline',
          description: 'test flow',
          stages: sampleStages,
          cron: '0 0 * * *',
          ...ds,
        });
        expect(created.id).toMatch(/^wfl_/);
        expect(created.enabled).toBe(true);
        expect(await repo.list('bob')).toEqual([]);
        expect(await repo.get('bob', created.id)).toBeUndefined();

        const updated = await repo.update('alice', created.id, {
          enabled: false,
          description: 'updated',
        });
        expect(updated?.enabled).toBe(false);
        expect(updated?.description).toBe('updated');

        expect(await repo.delete('bob', created.id)).toBe(false);
        expect(await repo.delete('alice', created.id)).toBe(true);
      });

      it('lists enabled workflows with cron for scheduler', async () => {
        const repo = new WorkflowRepository(await open());
        await repo.create('alice', {
          name: 'cron',
          stages: sampleStages,
          cron: '* * * * *',
          ...ds,
        });
        await repo.create('bob', {
          name: 'manual',
          stages: sampleStages,
          cron: null,
          ...ds,
        });
        await repo.create('carol', {
          name: 'off',
          stages: sampleStages,
          cron: '* * * * *',
          enabled: false,
          ...ds,
        });
        const enabled = await repo.listAllEnabled();
        expect(enabled.map((w) => w.name).sort()).toEqual(['cron']);
      });

      it('run の result key を outbox に残してから workflow を削除する', async () => {
        const db2 = await open();
        const repo = new WorkflowRepository(db2);
        const runs = new WorkflowRunRepository(db2, 50);
        const deletions = new ResultObjectDeletionRepository(db2);
        const w = await repo.create('alice', {
          name: 'w',
          stages: sampleStages,
          ...ds,
        });
        const runId = await runs.startRun(
          w,
          'manual',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
        );
        const stepRunId = (await runs.getRun(runId))!.steps[0]!.id;
        await runs.finishStep(stepRunId, {
          status: 'success',
          attempt: 1,
          resultObjectKey: 'hubble-results/workflow/delete.jsonl.gz',
          resultExpiresAt: '2026-02-01T00:00:00.000Z',
          finishedAt: '2026-01-01T00:00:01.000Z',
        });
        await runs.finishRun(runId, w.id, {
          status: 'success',
          finishedAt: '2026-01-01T00:00:01.000Z',
          elapsedMs: 1,
        });
        expect(await runs.listRuns(w.id, 10)).toHaveLength(1);
        await repo.delete('alice', w.id);
        expect(await runs.listRuns(w.id, 10)).toHaveLength(0);
        expect(await deletions.listForTest()).toEqual([
          expect.objectContaining({
            key: 'hubble-results/workflow/delete.jsonl.gz',
            attempts: 0,
          }),
        ]);
      });

      it('workflow 削除後に step が完了しても result key を outbox に残す', async () => {
        const db2 = await open();
        const repo = new WorkflowRepository(db2);
        const runs = new WorkflowRunRepository(db2, 50);
        const deletions = new ResultObjectDeletionRepository(db2);
        const workflow = await repo.create('alice', {
          name: 'delete before finish',
          stages: workflowDefinitionSchema.parse([
            { steps: [{ id: 'st_x', name: 'X', statement: 'SELECT 1' }] },
          ]),
          ...ds,
        });
        const runId = await runs.startRun(
          workflow,
          'manual',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
        );
        const stepRunId = (await runs.getRun(runId))!.steps[0]!.id;

        await repo.delete('alice', workflow.id);
        await runs.finishStep(stepRunId, {
          status: 'success',
          attempt: 1,
          resultObjectKey: 'hubble-results/workflow/delete-before-finish.jsonl.gz',
          resultExpiresAt: '2026-02-01T00:00:00.000Z',
          finishedAt: '2026-01-01T00:00:01.000Z',
        });

        expect(await runs.getRun(runId)).toBeUndefined();
        expect(await deletions.listForTest()).toEqual([
          expect.objectContaining({
            key: 'hubble-results/workflow/delete-before-finish.jsonl.gz',
            attempts: 0,
          }),
        ]);
      });

      it('delete 後の finishStep で outbox insert が失敗しても一部登録を残さない', async () => {
        const db2 = await open();
        const repo = new WorkflowRepository(db2);
        const runs = new WorkflowRunRepository(db2, 50);
        const deletions = new ResultObjectDeletionRepository(db2);
        const workflow = await repo.create('alice', {
          name: 'finish rollback',
          stages: workflowDefinitionSchema.parse([
            { steps: [{ id: 'st_x', name: 'X', statement: 'SELECT 1' }] },
          ]),
          ...ds,
        });
        const runId = await runs.startRun(
          workflow,
          'manual',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
        );
        const stepRunId = (await runs.getRun(runId))!.steps[0]!.id;
        await repo.delete('alice', workflow.id);
        const failingRuns = new WorkflowRunRepository(failAfterResultObjectDeletionInsert(db2), 50);

        await expect(
          failingRuns.finishStep(stepRunId, {
            status: 'success',
            attempt: 1,
            resultObjectKey: 'hubble-results/workflow/finish-rollback.jsonl.gz',
            resultExpiresAt: '2026-02-01T00:00:00.000Z',
            finishedAt: '2026-01-01T00:00:01.000Z',
          }),
        ).rejects.toThrow('outbox unavailable');
        expect(await deletions.listForTest()).toEqual([]);
      });

      const atomicDeleteTest = backend.name === 'sqlite' ? it : it.skip;
      atomicDeleteTest(
        'outbox insert 失敗時は workflow と run の削除を rollback する',
        async () => {
          const db2 = await open();
          const repo = new WorkflowRepository(db2);
          const runs = new WorkflowRunRepository(db2, 50);
          const workflow = await repo.create('alice', {
            name: 'rollback',
            stages: workflowDefinitionSchema.parse([
              { steps: [{ id: 'st_x', name: 'X', statement: 'SELECT 1' }] },
            ]),
            ...ds,
          });
          const runId = await runs.startRun(
            workflow,
            'manual',
            '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:00:00.000Z',
          );
          const stepRunId = (await runs.getRun(runId))!.steps[0]!.id;
          await runs.finishStep(stepRunId, {
            status: 'success',
            attempt: 1,
            resultObjectKey: 'hubble-results/workflow/rollback.jsonl.gz',
            resultExpiresAt: '2026-02-01T00:00:00.000Z',
            finishedAt: '2026-01-01T00:00:01.000Z',
          });
          await db2.exec(
            `CREATE TRIGGER reject_result_object_deletion
           BEFORE INSERT ON result_object_deletions
           BEGIN
             SELECT RAISE(ABORT, 'outbox unavailable');
           END;`,
          );

          await expect(repo.delete('alice', workflow.id)).rejects.toThrow('outbox unavailable');
          expect(await repo.get('alice', workflow.id)).toBeDefined();
          expect(await runs.getRun(runId)).toBeDefined();
        },
      );
    });

    describe('WorkflowRunRepository', () => {
      it('atomically claims one running row for concurrent requests', async () => {
        const db2 = await open();
        const workflows = new WorkflowRepository(db2);
        const runs = new WorkflowRunRepository(db2, 50);
        const workflow = await workflows.create('alice', {
          name: 'claim',
          stages: sampleStages,
          ...ds,
        });
        const start = () =>
          runs.startRun(workflow, 'manual', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

        const claims = await Promise.allSettled([start(), start()]);
        expect(claims.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(claims.filter((result) => result.status === 'rejected')).toHaveLength(1);
        expect(claims.find((result) => result.status === 'rejected')).toMatchObject({
          reason: expect.any(WorkflowRunClaimConflictError),
        });
        expect(await runs.listRuns(workflow.id, 10)).toHaveLength(1);
      });

      it('delete が先に完了した workflow record から run を再生成しない', async () => {
        const db2 = await open();
        const workflows = new WorkflowRepository(db2);
        const runs = new WorkflowRunRepository(db2, 50);
        const workflow = await workflows.create('alice', {
          name: 'deleted target',
          stages: sampleStages,
          ...ds,
        });
        await workflows.delete('alice', workflow.id);

        await expect(
          runs.startRun(workflow, 'manual', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
        ).rejects.toBeInstanceOf(WorkflowRunTargetNotFoundError);
        expect(await runs.listRuns(workflow.id, 10)).toEqual([]);
      });

      it('expands steps on startRun and finishes run', async () => {
        const db2 = await open();
        const repo = new WorkflowRepository(db2);
        const runs = new WorkflowRunRepository(db2, 50);
        const w = await repo.create('alice', {
          name: 'w',
          stages: sampleStages,
          ...ds,
        });
        const runId = await runs.startRun(
          w,
          'manual',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
        );
        const detail = await runs.getRun(runId);
        expect(detail?.steps).toHaveLength(3);
        expect(detail?.steps.map((s) => s.stepId)).toEqual(['st_a', 'st_b', 'st_c']);
        expect(detail?.status).toBe('running');

        await runs.finishRun(runId, w.id, {
          status: 'success',
          finishedAt: '2026-01-01T00:00:01.000Z',
          elapsedMs: 5,
        });
        const finished = await runs.getRun(runId);
        expect(finished?.status).toBe('success');
        expect(finished?.elapsedMs).toBe(5);
      });

      it('複数 workflow の直近 run と step 集計を固定2クエリで取得する', async () => {
        const db2 = await open();
        const workflows = new WorkflowRepository(db2);
        const runs = new WorkflowRunRepository(db2, 50);
        const first = await workflows.create('alice', {
          name: 'first',
          stages: sampleStages,
          ...ds,
        });
        const second = await workflows.create('alice', {
          name: 'second',
          stages: sampleStages,
          ...ds,
        });
        const firstRun = await runs.startRun(
          first,
          'manual',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
        );
        const secondRun = await runs.startRun(
          second,
          'manual',
          '2026-01-01T00:01:00.000Z',
          '2026-01-01T00:01:00.000Z',
        );
        const query = vi.spyOn(db2, 'query');
        query.mockClear();

        const latest = await runs.latestMany([first.id, second.id]);

        expect(query).toHaveBeenCalledTimes(2);
        expect(latest.get(first.id)).toMatchObject({ id: firstRun, stepCounts: { total: 3 } });
        expect(latest.get(second.id)).toMatchObject({ id: secondRun, stepCounts: { total: 3 } });
      });

      it('1000件超の workflow id を500件ずつに分割する', async () => {
        const db2 = await open();
        const runs = new WorkflowRunRepository(db2, 50);
        const query = vi.spyOn(db2, 'query');

        const latest = await runs.latestMany(
          Array.from({ length: 1_001 }, (_, index) => `wfl_${index}`),
        );

        expect(latest.size).toBe(0);
        expect(query).toHaveBeenCalledTimes(3);
        expect(query.mock.calls.map((call) => call[1]?.length)).toEqual([500, 500, 1]);
      });

      it('run 一覧の step 集計をrun件数に依存しない2クエリで取得する', async () => {
        const db2 = await open();
        const workflows = new WorkflowRepository(db2);
        const runs = new WorkflowRunRepository(db2, 50);
        const workflow = await workflows.create('alice', {
          name: 'list',
          stages: sampleStages,
          ...ds,
        });
        for (let minute = 0; minute < 2; minute += 1) {
          const timestamp = `2026-01-01T00:0${minute}:00.000Z`;
          const runId = await runs.startRun(workflow, 'manual', timestamp, timestamp);
          await runs.finishRun(runId, workflow.id, {
            status: 'success',
            finishedAt: timestamp,
            elapsedMs: 1,
          });
        }
        const query = vi.spyOn(db2, 'query');
        query.mockClear();

        const listed = await runs.listRuns(workflow.id, 10);

        expect(listed).toHaveLength(2);
        expect(query).toHaveBeenCalledTimes(2);
      });

      it('aborts orphan runs and skips pending steps', async () => {
        const db2 = await open();
        const repo = new WorkflowRepository(db2);
        const runs = new WorkflowRunRepository(db2, 50);
        const w = await repo.create('alice', {
          name: 'w',
          stages: sampleStages,
          ...ds,
        });
        const runId = await runs.startRun(
          w,
          'manual',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
        );
        const stepRuns = (await runs.getRun(runId))!.steps;
        await runs.markStepRunning(stepRuns[0]!.id, '2026-01-01T00:00:00.000Z');

        const aborted = await runs.abortOrphans('2026-01-01T00:01:00.000Z');
        expect(aborted).toBe(1);
        const after = await runs.getRun(runId);
        expect(after?.status).toBe('aborted');
        expect(after?.steps.find((s) => s.stepId === 'st_a')?.status).toBe('aborted');
        expect(after?.steps.find((s) => s.stepId === 'st_b')?.status).toBe('skipped');
      });

      it('prunes old runs on finishRun', async () => {
        const db2 = await open();
        const repo = new WorkflowRepository(db2);
        const runs = new WorkflowRunRepository(db2, 2);
        const deletions = new ResultObjectDeletionRepository(db2);
        const w = await repo.create('alice', {
          name: 'w',
          stages: workflowDefinitionSchema.parse([
            { steps: [{ id: 'st_x', name: 'X', statement: 'SELECT 1' }] },
          ]),
          ...ds,
        });
        for (let i = 0; i < 4; i++) {
          const ts = `2026-01-01T00:0${i}:00.000Z`;
          const runId = await runs.startRun(w, 'manual', ts, ts);
          const stepRunId = (await runs.getRun(runId))!.steps[0]!.id;
          await runs.finishStep(stepRunId, {
            status: 'success',
            attempt: 1,
            resultObjectKey: `hubble-results/workflow/prune-${i}.jsonl.gz`,
            resultExpiresAt: '2026-02-01T00:00:00.000Z',
            finishedAt: ts,
          });
          await runs.finishRun(runId, w.id, {
            status: 'success',
            finishedAt: ts,
            elapsedMs: 1,
          });
        }
        expect(await runs.listRuns(w.id, 10)).toHaveLength(2);
        expect((await deletions.listForTest()).map((job) => job.key)).toEqual([
          'hubble-results/workflow/prune-0.jsonl.gz',
          'hubble-results/workflow/prune-1.jsonl.gz',
        ]);
      });

      const atomicPruneTest = backend.name === 'sqlite' ? it : it.skip;
      atomicPruneTest(
        'outbox insert 失敗時は retention 対象の run 削除を rollback する',
        async () => {
          const db2 = await open();
          const repo = new WorkflowRepository(db2);
          const runs = new WorkflowRunRepository(db2, 1);
          const workflow = await repo.create('alice', {
            name: 'prune rollback',
            stages: workflowDefinitionSchema.parse([
              { steps: [{ id: 'st_x', name: 'X', statement: 'SELECT 1' }] },
            ]),
            ...ds,
          });
          const firstRunId = await runs.startRun(
            workflow,
            'manual',
            '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:00:00.000Z',
          );
          const firstStepId = (await runs.getRun(firstRunId))!.steps[0]!.id;
          await runs.finishStep(firstStepId, {
            status: 'success',
            attempt: 1,
            resultObjectKey: 'hubble-results/workflow/prune-rollback.jsonl.gz',
            resultExpiresAt: '2026-02-01T00:00:00.000Z',
            finishedAt: '2026-01-01T00:00:01.000Z',
          });
          await runs.finishRun(firstRunId, workflow.id, {
            status: 'success',
            finishedAt: '2026-01-01T00:00:01.000Z',
            elapsedMs: 1,
          });
          const secondRunId = await runs.startRun(
            workflow,
            'manual',
            '2026-01-01T00:01:00.000Z',
            '2026-01-01T00:01:00.000Z',
          );
          await db2.exec(
            `CREATE TRIGGER reject_pruned_result_object_deletion
           BEFORE INSERT ON result_object_deletions
           BEGIN
             SELECT RAISE(ABORT, 'outbox unavailable');
           END;`,
          );

          await expect(
            runs.finishRun(secondRunId, workflow.id, {
              status: 'success',
              finishedAt: '2026-01-01T00:01:01.000Z',
              elapsedMs: 1,
            }),
          ).rejects.toThrow('outbox unavailable');
          expect(await runs.getRun(firstRunId)).toBeDefined();
          expect(await runs.listRuns(workflow.id, 10)).toHaveLength(2);
        },
      );

      it('lists expired step results', async () => {
        const db2 = await open();
        const repo = new WorkflowRepository(db2);
        const runs = new WorkflowRunRepository(db2, 50);
        const w = await repo.create('alice', {
          name: 'w',
          stages: workflowDefinitionSchema.parse([
            { steps: [{ id: 'st_x', name: 'X', statement: 'SELECT 1' }] },
          ]),
          ...ds,
        });
        const runId = await runs.startRun(
          w,
          'manual',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
        );
        const stepRunId = (await runs.getRun(runId))!.steps[0]!.id;
        await runs.finishStep(stepRunId, {
          status: 'success',
          attempt: 1,
          rowCount: 1,
          elapsedMs: 1,
          resultObjectKey: 'hubble-results/workflow/x.jsonl.gz',
          resultExpiresAt: '2020-01-01T00:00:00.000Z',
          finishedAt: '2026-01-01T00:00:01.000Z',
        });
        const expired = await runs.listExpiredResults('2026-06-01T00:00:00.000Z');
        expect(expired).toEqual([
          {
            id: stepRunId,
            resultObjectKey: 'hubble-results/workflow/x.jsonl.gz',
            resultExpiresAt: '2020-01-01T00:00:00.000Z',
          },
        ]);
        await runs.clearResultObjects(['hubble-results/workflow/x.jsonl.gz']);
        const step = await runs.getStepRun(runId, stepRunId);
        expect(step?.resultObjectKey).toBeNull();
      });
    });
  });
}
