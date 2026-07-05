/**
 * WorkflowRepository / WorkflowRunRepository の振る舞いを dbBackends で検証する。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SqlDatabase } from '../db/sqlDatabase';
import { workflowDefinitionSchema } from '@hubble/contracts';
import { dbBackends } from '../test/dbBackends';
import { DEFAULT_DATASOURCE_ID } from '../test/testEngine';
import { WorkflowRepository, WorkflowRunRepository } from './workflows';

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

for (const backend of dbBackends) {
  describe(`workflow repositories on ${backend.name}`, () => {
    let db: SqlDatabase;

    afterEach(async () => {
      if (db) {
        if (db.dialect === 'postgres') {
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

      it('cascade-deletes runs when workflow is removed', async () => {
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
        await runs.finishRun(runId, w.id, {
          status: 'success',
          finishedAt: '2026-01-01T00:00:01.000Z',
          elapsedMs: 1,
        });
        expect(await runs.listRuns(w.id, 10)).toHaveLength(1);
        await repo.delete('alice', w.id);
        expect(await runs.listRuns(w.id, 10)).toHaveLength(0);
      });
    });

    describe('WorkflowRunRepository', () => {
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
          await runs.finishRun(runId, w.id, {
            status: 'success',
            finishedAt: ts,
            elapsedMs: 1,
          });
        }
        expect(await runs.listRuns(w.id, 10)).toHaveLength(2);
      });

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
          { id: stepRunId, resultObjectKey: 'hubble-results/workflow/x.jsonl.gz' },
        ]);
        await runs.clearResultObjects(['hubble-results/workflow/x.jsonl.gz']);
        const step = await runs.getStepRun(runId, stepRunId);
        expect(step?.resultObjectKey).toBeNull();
      });
    });
  });
}
