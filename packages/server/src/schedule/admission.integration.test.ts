/**
 * services 層が schedule、workflow、alert に同じ admission controller を配線することを検証する。
 */
import { describe, expect, it, vi } from 'vitest';
import { workflowDefinitionSchema } from '@hubble/contracts';
import { createTestContext } from '../test/harness';
import { DEFAULT_DATASOURCE_ID } from '../test/testEngine';
import { JobAdmissionRejectedError } from './admission';

const VALIDATE_OK = {
  match: 'EXPLAIN (TYPE VALIDATE)',
  pages: [{ columns: [{ name: 'result', type: 'boolean' }], data: [[true]] }],
};

describe('shared job admission wiring', () => {
  it('rejects workflow and alert manual or cron triggers while a schedule holds the only slot', async () => {
    let now = Date.parse('2026-07-12T00:00:00.000Z');
    const ctx = await createTestContext({
      scenarios: [
        VALIDATE_OK,
        {
          match: 'SELECT_HOLD_ADMISSION',
          pages: [{ columns: [{ name: 'n', type: 'bigint' }], data: [[1]] }],
        },
      ],
      configOverrides: {
        scheduler: {
          enabled: false,
          tickSeconds: 15,
          maxConcurrent: 1,
          runsRetention: 50,
        },
      },
      now: () => now,
    });
    let releaseAdvance!: () => void;
    ctx.fake.holdAdvance = new Promise<void>((resolve) => {
      releaseAdvance = resolve;
    });
    const schedule = await ctx.services.schedules.create('alice', {
      name: 'holder',
      statement: 'SELECT 1 /* SELECT_HOLD_ADMISSION */',
      cron: '* * * * *',
      datasourceId: DEFAULT_DATASOURCE_ID,

      principalSnapshot: { user: 'alice' },
    });
    const workflow = await ctx.services.workflows.create('alice', {
      name: 'blocked workflow',
      cron: '* * * * *',
      stages: workflowDefinitionSchema.parse([
        { steps: [{ id: 'step-a', name: 'A', statement: 'SELECT 1' }] },
      ]),
      datasourceId: DEFAULT_DATASOURCE_ID,

      principalSnapshot: { user: 'alice' },
    });
    const alert = await ctx.services.alerts.create('alice', {
      name: 'blocked alert',
      savedQueryId: 'sq_unused',
      columnName: 'value',
      op: '>',
      value: '0',
      cron: '* * * * *',

      principalSnapshot: { user: 'alice' },
    });

    await ctx.services.workflowRunner.tick();
    await ctx.services.alertEvaluator.tick();
    await ctx.services.scheduler.runManual(schedule);
    await vi.waitFor(() => expect(ctx.fake.activeCount).toBe(1));

    now += 61_000;
    await ctx.services.workflowRunner.tick();
    await ctx.services.alertEvaluator.tick();
    await ctx.services.workflowRunner.whenIdle();
    await ctx.services.alertEvaluator.whenIdle();
    expect(await ctx.services.workflowRuns.listRuns(workflow.id, 10)).toEqual([]);
    expect((await ctx.services.alerts.get('alice', alert.id))?.state).toBe('unknown');

    await expect(ctx.services.workflowRunner.runManual(workflow)).rejects.toMatchObject({
      reason: 'capacity',
    } satisfies Partial<JobAdmissionRejectedError>);
    await expect(ctx.services.alertEvaluator.evalManual(alert)).rejects.toMatchObject({
      reason: 'capacity',
    } satisfies Partial<JobAdmissionRejectedError>);

    releaseAdvance();
    await ctx.services.scheduler.whenIdle();
    await ctx.services.shutdown();
  });
});
