import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import {
  workflowRunExportResponseSchema,
  workflowRunSchema,
  workflowSchema,
  workflowStepResultPageSchema,
  type Workflow,
} from '@hubble/contracts';
import { createTestContext } from '../test/harness';
import type { FakeScenario } from '../test/fakeTrino';
import type { ResultArtifactFormat, ResultStore } from '../resultStore';
import type { SheetsApiClient } from '../query/exportSheets';
import { WorkflowRunTargetNotFoundError } from '../store/workflows';

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

  async put(key: string, body: Readable, _format: ResultArtifactFormat): Promise<void> {
    void _format;
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

  async close(): Promise<void> {}
}

const sampleStages = [{ steps: [{ id: 'st_ok', name: 'Ok', statement: 'SELECT_OK' }] }];

function writeWorkflowRbacFixtures(dir: string): void {
  writeFileSync(
    join(dir, 'datasources.yaml'),
    `datasources:
  - id: trino-allowed
    type: trino
    username: trino
    baseUrl: http://trino.test
  - id: trino-denied
    type: trino
    username: trino
    baseUrl: http://trino.test
`,
    'utf8',
  );
  writeFileSync(
    join(dir, 'rbac.yaml'),
    `roles:
  analyst:
    permissions: [query.write]
    datasources: [trino-allowed]
defaultRole: analyst
`,
    'utf8',
  );
}

function validationRequestCount(ctx: Awaited<ReturnType<typeof createTestContext>>): number {
  return ctx.fake.requests.filter(
    (request) => request.method === 'POST' && request.body?.includes('EXPLAIN (TYPE VALIDATE)'),
  ).length;
}

const twoStepStages = [
  {
    steps: [
      { id: 'st_a', name: 'Step A', statement: 'SELECT_A' },
      { id: 'st_b', name: 'Step B', statement: 'SELECT_B' },
    ],
  },
];

const twoStepScenarios: FakeScenario[] = [
  VALIDATE_OK,
  {
    match: 'SELECT_A',
    pages: [{ columns: [{ name: 'a', type: 'bigint' }], data: [[1]] }],
  },
  {
    match: 'SELECT_B',
    pages: [{ columns: [{ name: 'b', type: 'bigint' }], data: [[2], [3]] }],
  },
];

async function createTwoStepRun(
  ctx: Awaited<ReturnType<typeof createTestContext>>,
  extraHeaders: Record<string, string> = {},
): Promise<{
  workflow: Workflow;
  runId: string;
}> {
  const headers = { ...jsonHeaders(), ...extraHeaders };
  const createRes = await ctx.app.request('/api/workflows', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'export-flow', stages: twoStepStages }),
  });
  const workflow = workflowSchema.parse(await createRes.json()) as Workflow;
  const runRes = await ctx.app.request(`/api/workflows/${workflow.id}/run`, {
    method: 'POST',
    headers: extraHeaders,
  });
  const { runId } = (await runRes.json()) as { runId: string };
  await ctx.services.workflowRunner.whenIdle();
  return { workflow, runId };
}

describe('workflow routes', () => {
  it('run 開始直前に workflow が削除された場合は 404 を返す', async () => {
    const ctx = await createTestContext({ scenarios: [VALIDATE_OK] });
    try {
      const createRes = await ctx.app.request('/api/workflows', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ name: 'stale run', stages: sampleStages }),
      });
      const workflow = workflowSchema.parse(await createRes.json()) as Workflow;
      vi.spyOn(ctx.services.workflowRunner, 'runManual').mockRejectedValueOnce(
        new WorkflowRunTargetNotFoundError(workflow.id),
      );

      const runRes = await ctx.app.request(`/api/workflows/${workflow.id}/run`, {
        method: 'POST',
      });
      expect(runRes.status).toBe(404);
    } finally {
      await ctx.services.shutdown();
    }
  });

  it('rejects a denied step datasource before validating any step on create', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hubble-workflow-create-rbac-'));
    writeWorkflowRbacFixtures(dir);
    const ctx = await createTestContext({ scenarios: [VALIDATE_OK], cwd: dir });
    try {
      const res = await ctx.app.request('/api/workflows', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          name: 'denied-create',
          datasourceId: 'trino-allowed',
          stages: [
            {
              steps: [
                { id: 'st_allowed', name: 'Allowed', statement: 'SELECT 1' },
                {
                  id: 'st_denied',
                  name: 'Denied',
                  statement: 'SELECT 2',
                  datasourceId: 'trino-denied',
                },
              ],
            },
          ],
        }),
      });

      expect(res.status).toBe(404);
      expect(validationRequestCount(ctx)).toBe(0);
    } finally {
      await ctx.services.shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a denied step datasource before validating any step on update', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hubble-workflow-update-rbac-'));
    writeWorkflowRbacFixtures(dir);
    const ctx = await createTestContext({ scenarios: [VALIDATE_OK], cwd: dir });
    try {
      const createRes = await ctx.app.request('/api/workflows', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          name: 'allowed-update',
          datasourceId: 'trino-allowed',
          stages: sampleStages,
        }),
      });
      expect(createRes.status).toBe(201);
      const workflow = workflowSchema.parse(await createRes.json()) as Workflow;
      ctx.fake.requests.length = 0;

      const res = await ctx.app.request(`/api/workflows/${workflow.id}`, {
        method: 'PATCH',
        headers: jsonHeaders(),
        body: JSON.stringify({
          stages: [
            {
              steps: [
                { id: 'st_allowed', name: 'Allowed', statement: 'SELECT 1' },
                {
                  id: 'st_denied',
                  name: 'Denied',
                  statement: 'SELECT 2',
                  datasourceId: 'trino-denied',
                },
              ],
            },
          ],
        }),
      });

      expect(res.status).toBe(404);
      expect(validationRequestCount(ctx)).toBe(0);
    } finally {
      await ctx.services.shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  });

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

describe('workflow run bulk export routes', () => {
  const aliceHeaders = { 'x-forwarded-email': 'alice@example.com' };

  it('downloads zip and xlsx, exports sheets, and records audit', async () => {
    const addSheet = vi.fn<SheetsApiClient['addSheet']>(async () => undefined);
    const renameFirstSheet = vi.fn<SheetsApiClient['renameFirstSheet']>(async () => undefined);
    const appendValues = vi.fn<SheetsApiClient['appendValues']>(async () => undefined);
    const shareWithWriter = vi.fn<SheetsApiClient['shareWithWriter']>(async () => undefined);
    const store = new MemoryResultStore();
    const ctx = await createTestContext({
      scenarios: twoStepScenarios,
      resultStore: store,
      env: { AUTH_MODE: 'proxy', EXPORT_SHEETS_CREDENTIALS_FILE: '/secure/key.json' },
      remoteAddress: () => '127.0.0.1',
      sheetsClientFactory: async () => ({
        createSpreadsheet: async () => ({
          spreadsheetId: 'wf_sheet_1',
          url: 'https://docs.google.com/spreadsheets/d/wf_sheet_1',
        }),
        appendValues,
        renameFirstSheet,
        addSheet,
        shareWithWriter,
      }),
    });

    const { runId } = await createTwoStepRun(ctx, aliceHeaders);

    const zipRes = await ctx.app.request(`/api/workflow-runs/${runId}/download.zip`, {
      headers: aliceHeaders,
    });
    expect(zipRes.status).toBe(200);
    const zipBytes = Buffer.from(await zipRes.arrayBuffer());
    expect(zipBytes.subarray(0, 2).toString('utf8')).toBe('PK');

    const xlsxRes = await ctx.app.request(`/api/workflow-runs/${runId}/download.xlsx`, {
      headers: aliceHeaders,
    });
    expect(xlsxRes.status).toBe(200);
    const xlsxBytes = Buffer.from(await xlsxRes.arrayBuffer());
    expect(xlsxBytes.subarray(0, 2).toString('utf8')).toBe('PK');
    expect(xlsxRes.headers.get('content-type')).toContain('spreadsheetml.sheet');

    const sheetsRes = await ctx.app.request(`/api/workflow-runs/${runId}/export`, {
      method: 'POST',
      headers: {
        ...jsonHeaders(),
        ...aliceHeaders,
      },
      body: JSON.stringify({ destination: 'sheets' }),
    });
    expect(sheetsRes.status).toBe(200);
    const exported = workflowRunExportResponseSchema.parse(await sheetsRes.json());
    expect(exported.spreadsheetId).toBe('wf_sheet_1');
    expect(renameFirstSheet).toHaveBeenCalled();
    expect(addSheet).toHaveBeenCalledTimes(1);

    const auditRows = await ctx.services.audit.listForTest();
    expect(
      auditRows.some(
        (row) => row.action === 'csv.download' && row.target === `workflow-run:${runId}`,
      ),
    ).toBe(true);
    expect(
      auditRows.some(
        (row) => row.action === 'export.xlsx' && row.target === `workflow-run:${runId}`,
      ),
    ).toBe(true);
    expect(
      auditRows.some(
        (row) => row.action === 'export.sheets' && row.target === `workflow-run:${runId}`,
      ),
    ).toBe(true);
    await ctx.services.shutdown();
  });

  it('returns 404 for non-owner', async () => {
    const store = new MemoryResultStore();
    const ctx = await createTestContext({
      scenarios: twoStepScenarios,
      resultStore: store,
      env: { AUTH_MODE: 'proxy' },
      remoteAddress: () => '127.0.0.1',
    });
    const { runId } = await createTwoStepRun(ctx, aliceHeaders);

    const res = await ctx.app.request(`/api/workflow-runs/${runId}/download.zip`, {
      headers: { 'x-forwarded-email': 'bob@example.com' },
    });
    expect(res.status).toBe(404);
    await ctx.services.shutdown();
  });

  it('returns 409 while run is still running', async () => {
    const store = new MemoryResultStore();
    const ctx = await createTestContext({
      scenarios: [
        VALIDATE_OK,
        {
          match: 'SELECT_HOLD',
          pages: [{ columns: [{ name: 'n', type: 'bigint' }], data: [[1]] }],
        },
      ],
      resultStore: store,
    });
    const createRes = await ctx.app.request('/api/workflows', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        name: 'hold-export',
        stages: [{ steps: [{ id: 'st_hold', name: 'Hold', statement: 'SELECT_HOLD' }] }],
      }),
    });
    const workflow = workflowSchema.parse(await createRes.json()) as Workflow;
    ctx.fake.holdAdvance = new Promise(() => {});
    const runRes = await ctx.app.request(`/api/workflows/${workflow.id}/run`, { method: 'POST' });
    const { runId } = (await runRes.json()) as { runId: string };

    const res = await ctx.app.request(`/api/workflow-runs/${runId}/download.zip`);
    expect(res.status).toBe(409);
  });

  it('returns RESULT_NOT_PERSISTED when no persisted results exist', async () => {
    const ctx = await createTestContext({ scenarios: twoStepScenarios });
    const { runId } = await createTwoStepRun(ctx);

    const res = await ctx.app.request(`/api/workflow-runs/${runId}/download.zip`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('RESULT_NOT_PERSISTED');
    await ctx.services.shutdown();
  });

  it('returns 403 when a step datasource is outside the role allowlist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hubble-workflow-export-rbac-'));
    try {
      writeFileSync(
        join(dir, 'rbac.yaml'),
        `roles:
  unrestricted:
    permissions: [query.write]
    datasources: ['*']
  trino-prod-only:
    permissions: [query.write]
    datasources: [trino-prod]
assignments:
  - user: alice
    role: unrestricted
defaultRole: unrestricted
`,
        'utf8',
      );
      const store = new MemoryResultStore();
      const ctx = await createTestContext({
        scenarios: twoStepScenarios,
        resultStore: store,
        cwd: dir,
        env: { RBAC_PATH: join(dir, 'rbac.yaml'), AUTH_MODE: 'proxy' },
        remoteAddress: () => '127.0.0.1',
      });
      const { runId } = await createTwoStepRun(ctx, aliceHeaders);

      writeFileSync(
        join(dir, 'rbac.yaml'),
        `roles:
  trino-prod-only:
    permissions: [query.write]
    datasources: [trino-prod]
assignments:
  - user: alice
    role: trino-prod-only
defaultRole: trino-prod-only
`,
        'utf8',
      );
      await ctx.services.reloadRbac();

      const res = await ctx.app.request(`/api/workflow-runs/${runId}/download.zip`, {
        headers: aliceHeaders,
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toContain('trino-default');
      await ctx.services.shutdown();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
