import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import {
  workflowRunSchema,
  workflowSchema,
  workflowStepResultPageSchema,
  type Workflow,
} from '@hubble/contracts';
import { createTestContext } from '../test/harness';
import type { FakeScenario } from '../test/fakeTrino';
import type { ResultStore } from '../resultStore';

const VALIDATE_OK: FakeScenario = {
  match: 'EXPLAIN (TYPE VALIDATE)',
  pages: [{ columns: [{ name: 'result', type: 'boolean' }], data: [[true]] }],
};

function jsonHeaders(): Record<string, string> {
  return { 'content-type': 'application/json' };
}

class MemoryResultStore implements ResultStore {
  readonly enabled = true;
  readonly objects = new Map<string, Buffer>();

  async put(key: string, body: Readable): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    this.objects.set(key, Buffer.concat(chunks));
  }

  async getStream(key: string): Promise<Readable> {
    const data = this.objects.get(key);
    if (!data) throw new Error(`missing ${key}`);
    return Readable.from(data);
  }

  async delete(): Promise<void> {}

  async deleteExpired(objects: { key: string }[]) {
    for (const object of objects) this.objects.delete(object.key);
    return { deleted: objects.map((o) => o.key), failed: [] };
  }
}

const sampleStages = [{ steps: [{ id: 'st_ok', name: 'Ok', statement: 'SELECT_OK' }] }];

describe('workflow routes', () => {
  it('rejects creation with step validation details on USER_ERROR', async () => {
    const ctx = await createTestContext({
      scenarios: [
        {
          match: 'EXPLAIN (TYPE VALIDATE) SELECT_BAD',
          error: {
            message: "line 1:8: mismatched input 'FROM'",
            errorName: 'SYNTAX_ERROR',
            errorType: 'USER_ERROR',
            errorLocation: { lineNumber: 1, columnNumber: 8 },
          },
        },
      ],
    });
    const res = await ctx.app.request('/api/workflows', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        name: 'bad',
        stages: [{ steps: [{ id: 'st_bad', name: 'Bad', statement: 'SELECT_BAD' }] }],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details?: { stepId?: string; stepName?: string } };
    };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details?.stepId).toBe('st_bad');
    expect(body.error.details?.stepName).toBe('Bad');
    await ctx.services.shutdown();
  });

  it('creates, lists, gets, patches, deletes with owner scope', async () => {
    const ctx = await createTestContext({ scenarios: [VALIDATE_OK] });
    const createRes = await ctx.app.request('/api/workflows', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ name: 'flow', description: 'desc', stages: sampleStages }),
    });
    expect(createRes.status).toBe(201);
    const created = workflowSchema.parse(await createRes.json()) as Workflow;
    expect(created.id).toMatch(/^wfl_/);

    const listRes = await ctx.app.request('/api/workflows');
    expect(listRes.status).toBe(200);
    const listed = (await listRes.json()) as Workflow[];
    expect(listed).toHaveLength(1);

    const getRes = await ctx.app.request(`/api/workflows/${created.id}`);
    expect(getRes.status).toBe(200);

    const otherGet = await ctx.app.request(`/api/workflows/does-not-exist`);
    expect(otherGet.status).toBe(404);

    const patchRes = await ctx.app.request(`/api/workflows/${created.id}`, {
      method: 'PATCH',
      headers: jsonHeaders(),
      body: JSON.stringify({ enabled: false }),
    });
    expect(patchRes.status).toBe(200);
    expect((workflowSchema.parse(await patchRes.json()) as Workflow).enabled).toBe(false);

    const delRes = await ctx.app.request(`/api/workflows/${created.id}`, { method: 'DELETE' });
    expect(delRes.status).toBe(200);
    await ctx.services.shutdown();
  });

  it('runs manually, polls completion, returns step results, and records audit', async () => {
    const store = new MemoryResultStore();
    const ctx = await createTestContext({
      scenarios: [
        VALIDATE_OK,
        {
          match: 'SELECT_OK',
          pages: [
            {
              columns: [{ name: 'n', type: 'bigint' }],
              data: [[1], [2]],
            },
          ],
        },
      ],
      resultStore: store,
    });
    const createRes = await ctx.app.request('/api/workflows', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ name: 'run-me', stages: sampleStages }),
    });
    const workflow = workflowSchema.parse(await createRes.json()) as Workflow;

    const runRes = await ctx.app.request(`/api/workflows/${workflow.id}/run`, { method: 'POST' });
    expect(runRes.status).toBe(202);
    const { runId } = (await runRes.json()) as { runId: string };

    await ctx.services.workflowRunner.whenIdle();

    const detailRes = await ctx.app.request(`/api/workflow-runs/${runId}`);
    expect(detailRes.status).toBe(200);
    const run = workflowRunSchema.parse(await detailRes.json());
    expect(run.status).toBe('success');
    expect(run.steps[0]?.status).toBe('success');
    expect(run.steps[0]?.resultAvailable).toBe(true);

    const stepRunId = run.steps[0]!.id;
    const resultRes = await ctx.app.request(
      `/api/workflow-runs/${runId}/steps/${stepRunId}/result?limit=10`,
    );
    expect(resultRes.status).toBe(200);
    const page = workflowStepResultPageSchema.parse(await resultRes.json());
    expect(page.totalRows).toBe(2);

    const auditRows = await ctx.services.audit.listForTest();
    expect(auditRows.some((row) => row.action === 'workflow.execute')).toBe(true);
    await ctx.services.shutdown();
  });

  it('returns 409 when a run is already in progress', async () => {
    const ctx = await createTestContext({
      scenarios: [
        VALIDATE_OK,
        {
          match: 'SELECT_HOLD',
          pages: [{ columns: [{ name: 'n', type: 'bigint' }], data: [[1]] }],
        },
      ],
    });
    const createRes = await ctx.app.request('/api/workflows', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        name: 'hold',
        stages: [{ steps: [{ id: 'st_hold', name: 'Hold', statement: 'SELECT_HOLD' }] }],
      }),
    });
    const workflow = workflowSchema.parse(await createRes.json()) as Workflow;
    ctx.fake.holdAdvance = new Promise(() => {});

    const first = await ctx.app.request(`/api/workflows/${workflow.id}/run`, { method: 'POST' });
    expect(first.status).toBe(202);
    const second = await ctx.app.request(`/api/workflows/${workflow.id}/run`, { method: 'POST' });
    expect(second.status).toBe(409);
  });
});
