import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { workflowDefinitionSchema } from '@hubble/contracts';
import { openMemoryDatabase } from '../db';
import type { SqlDatabase } from '../db/sqlDatabase';
import { EstimateService } from '../query/estimateService';
import { WorkflowRepository, WorkflowRunRepository } from '../store/workflows';
import { FakeTrino, type FakeScenario } from '../test/fakeTrino';
import { loadRbac } from '../rbac/loader';
import type { LoadedRbac } from '../rbac/types';
import { DEFAULT_DATASOURCE_ID, makeEnginesMap } from '../test/testEngine';
import { WorkflowRunner } from './runner';
import { AuditLogger, AuditRepository } from '../audit';
import type { ResultStore } from '../resultStore';
import { NoneResultStore } from '../resultStore';

const VALIDATE_OK: FakeScenario = {
  match: 'EXPLAIN (TYPE VALIDATE)',
  pages: [{ columns: [{ name: 'result', type: 'boolean' }], data: [[true]] }],
};

function ioPlan(rows: number): string {
  return JSON.stringify({
    inputTableColumnInfos: [
      {
        table: { catalog: 'tpch', schemaTable: { schema: 'tiny', table: 't' } },
        estimate: { outputRowCount: rows, outputSizeInBytes: rows * 10 },
      },
    ],
    estimate: { outputRowCount: rows, outputSizeInBytes: rows * 10 },
  });
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

interface Harness {
  db: SqlDatabase;
  fake: FakeTrino;
  workflows: WorkflowRepository;
  runs: WorkflowRunRepository;
  runner: WorkflowRunner;
  audit: AuditLogger;
  resultStore: ResultStore;
  sleeps: number[];
}

async function makeHarness(
  scenarios: FakeScenario[],
  configOverrides: { guardMode?: 'off' | 'warn' | 'enforce' } = {},
  getRbac?: () => LoadedRbac,
  resultStore?: ResultStore,
  onSleep?: () => void,
): Promise<Harness> {
  const db = await openMemoryDatabase();
  const fake = new FakeTrino(scenarios);
  const { engines, defaultDatasourceId } = makeEnginesMap(fake);
  const workflows = new WorkflowRepository(db);
  const runs = new WorkflowRunRepository(db, 50);
  const audit = new AuditLogger(new AuditRepository(db));
  const store = resultStore ?? new MemoryResultStore();
  const estimate = new EstimateService(engines, defaultDatasourceId, {
    mode: configOverrides.guardMode ?? 'warn',
    maxScanBytes: 0,
    maxScanRows: 100,
    onUnknown: 'warn',
    estimateTimeoutMs: 3000,
    cacheTtlSeconds: 0,
    bytesPerSecond: 0,
  });
  const sleeps: number[] = [];
  const runner = new WorkflowRunner({
    workflows,
    runs,
    engines,
    defaultDatasourceId,
    estimate,
    getRbac: getRbac ?? (() => loadRbac({})),
    guardConfig: {
      mode: configOverrides.guardMode ?? 'warn',
      maxScanBytes: 0,
      maxScanRows: 100,
      onUnknown: 'warn',
      estimateTimeoutMs: 3000,
      cacheTtlSeconds: 0,
      bytesPerSecond: 0,
    },
    audit,
    resultStore: store,
    resultKeyPrefix: 'hubble-results/',
    resultTtlDays: 7,
    config: {
      enabled: false,
      tickSeconds: 15,
      maxConcurrent: 2,
      runsRetention: 50,
      guardMode: configOverrides.guardMode ?? 'warn',
    },
    sleep: (ms) => {
      onSleep?.();
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  return { db, fake, workflows, runs, runner, audit, resultStore: store, sleeps };
}

function executedStatements(fake: FakeTrino): string[] {
  return fake.requests
    .filter((r) => r.method === 'POST')
    .map((r) => r.body ?? '')
    .filter((body) => !body.startsWith('EXPLAIN'));
}

describe('WorkflowRunner', () => {
  let h: Harness;
  afterEach(async () => {
    if (h?.db) await h.db.close();
  });

  it('runs stages serially and steps within a stage in parallel', async () => {
    h = await makeHarness([
      VALIDATE_OK,
      {
        match: 'STAGE0_A',
        pages: [{ columns: [{ name: 'n', type: 'bigint' }], data: [[1]] }],
      },
      {
        match: 'STAGE0_B',
        pages: [{ columns: [{ name: 'n', type: 'bigint' }], data: [[1]] }],
      },
      {
        match: 'STAGE1_C',
        pages: [{ columns: [{ name: 'n', type: 'bigint' }], data: [[1]] }],
      },
    ]);
    const w = await h.workflows.create('alice', {
      name: 'order',
      stages: workflowDefinitionSchema.parse([
        {
          steps: [
            { id: 'st_a', name: 'A', statement: 'STAGE0_A' },
            { id: 'st_b', name: 'B', statement: 'STAGE0_B' },
          ],
        },
        { steps: [{ id: 'st_c', name: 'C', statement: 'STAGE1_C' }] },
      ]),
      datasourceId: DEFAULT_DATASOURCE_ID,
    });
    const { runId } = await h.runner.runManual(w);
    await h.runner.whenIdle();
    const run = await h.runs.getRun(runId);
    expect(run?.status).toBe('success');
    const executed = executedStatements(h.fake);
    expect(executed.filter((s) => s.includes('STAGE0'))).toHaveLength(2);
    expect(executed.indexOf('STAGE1_C')).toBeGreaterThan(
      Math.max(executed.indexOf('STAGE0_A'), executed.indexOf('STAGE0_B')),
    );
  });

  it('stops on stop-policy failure and skips later steps', async () => {
    h = await makeHarness([
      {
        match: 'EXPLAIN (TYPE VALIDATE) FAIL_STEP',
        error: {
          message: 'bad sql',
          errorName: 'SYNTAX_ERROR',
          errorType: 'USER_ERROR',
        },
      },
      VALIDATE_OK,
      {
        match: 'NEVER_RUN',
        pages: [{ data: [[1]] }],
      },
    ]);
    const w = await h.workflows.create('alice', {
      name: 'stop',
      stages: workflowDefinitionSchema.parse([
        { steps: [{ id: 'st_fail', name: 'Fail', statement: 'FAIL_STEP' }] },
        { steps: [{ id: 'st_next', name: 'Next', statement: 'NEVER_RUN' }] },
      ]),
      datasourceId: DEFAULT_DATASOURCE_ID,
    });
    const { runId } = await h.runner.runManual(w);
    await h.runner.whenIdle();
    const run = await h.runs.getRun(runId);
    expect(run?.status).toBe('failed');
    expect(run?.steps.find((s) => s.stepId === 'st_fail')?.status).toBe('failed');
    expect(run?.steps.find((s) => s.stepId === 'st_next')?.status).toBe('skipped');
    expect(executedStatements(h.fake)).not.toContain('NEVER_RUN');
  });

  it('continues on continue-policy failure and finishes partial', async () => {
    h = await makeHarness([
      {
        match: 'EXPLAIN (TYPE VALIDATE) FAIL_CONTINUE',
        error: {
          message: 'bad sql',
          errorName: 'SYNTAX_ERROR',
          errorType: 'USER_ERROR',
        },
      },
      VALIDATE_OK,
      {
        match: 'RUN_AFTER',
        pages: [{ columns: [{ name: 'n', type: 'bigint' }], data: [[1]] }],
      },
    ]);
    const w = await h.workflows.create('alice', {
      name: 'continue',
      stages: workflowDefinitionSchema.parse([
        {
          steps: [
            {
              id: 'st_fail',
              name: 'Fail',
              statement: 'FAIL_CONTINUE',
              onFailure: 'continue',
            },
          ],
        },
        { steps: [{ id: 'st_ok', name: 'Ok', statement: 'RUN_AFTER' }] },
      ]),
      datasourceId: DEFAULT_DATASOURCE_ID,
    });
    const { runId } = await h.runner.runManual(w);
    await h.runner.whenIdle();
    const run = await h.runs.getRun(runId);
    expect(run?.status).toBe('partial');
    expect(run?.steps.find((s) => s.stepId === 'st_ok')?.status).toBe('success');
  });

  it('retries transient failures at step level', async () => {
    const flakyFail: FakeScenario = {
      match: 'SELECT_FLAKY',
      error: {
        message: 'temporary engine fault',
        errorName: 'GENERIC_INTERNAL_ERROR',
        errorType: 'INTERNAL_ERROR',
      },
    };
    const flakyOk: FakeScenario = {
      match: 'SELECT_FLAKY',
      pages: [{ columns: [{ name: 'n', type: 'bigint' }], data: [[1]] }],
    };
    const holder: { fake?: FakeTrino } = {};
    h = await makeHarness([VALIDATE_OK, flakyFail], {}, undefined, new NoneResultStore(), () => {
      holder.fake?.setScenarios([VALIDATE_OK, flakyOk]);
    });
    holder.fake = h.fake;
    const w = await h.workflows.create('alice', {
      name: 'retry',
      stages: workflowDefinitionSchema.parse([
        { steps: [{ id: 'st_x', name: 'X', statement: 'SELECT_FLAKY' }] },
      ]),
      retry: { maxAttempts: 3, backoffSeconds: 30, backoffMultiplier: 2 },
      datasourceId: DEFAULT_DATASOURCE_ID,
    });
    const { runId } = await h.runner.runManual(w);
    await h.runner.whenIdle();
    const run = await h.runs.getRun(runId);
    expect(run?.status).toBe('success');
    expect(run?.steps[0]?.attempt).toBe(2);
    expect(h.sleeps).toEqual([30_000]);
  });

  it('blocks step when Query Guard enforces a block', async () => {
    h = await makeHarness(
      [
        VALIDATE_OK,
        {
          match: 'EXPLAIN (TYPE IO, FORMAT JSON) SELECT_BIG',
          pages: [{ columns: [{ name: 'json', type: 'varchar' }], data: [[ioPlan(500)]] }],
        },
        {
          match: 'SELECT_BIG',
          pages: [{ columns: [{ name: 'n', type: 'bigint' }], data: [[1]] }],
        },
      ],
      { guardMode: 'enforce' },
    );
    const w = await h.workflows.create('alice', {
      name: 'guard',
      stages: workflowDefinitionSchema.parse([
        { steps: [{ id: 'st_x', name: 'X', statement: 'SELECT_BIG' }] },
      ]),
      datasourceId: DEFAULT_DATASOURCE_ID,
    });
    const { runId } = await h.runner.runManual(w);
    await h.runner.whenIdle();
    const run = await h.runs.getRun(runId);
    expect(run?.status).toBe('failed');
    expect(run?.steps[0]?.status).toBe('blocked');
    expect(run?.steps[0]?.errorType).toBe('QUERY_BLOCKED');
  });

  it('blocks step when datasource is outside role allowlist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hubble-workflow-rbac-'));
    try {
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
      h = await makeHarness([VALIDATE_OK], {}, () =>
        loadRbac({ env: { RBAC_PATH: join(dir, 'rbac.yaml') }, cwd: dir }),
      );
      const w = await h.workflows.create('alice', {
        name: 'rbac',
        stages: workflowDefinitionSchema.parse([
          {
            steps: [
              {
                id: 'st_x',
                name: 'X',
                statement: 'SELECT 1',
                datasourceId: DEFAULT_DATASOURCE_ID,
              },
            ],
          },
        ]),
        datasourceId: 'trino-prod',
      });
      const { runId } = await h.runner.runManual(w);
      await h.runner.whenIdle();
      const run = await h.runs.getRun(runId);
      expect(run?.steps[0]?.status).toBe('blocked');
      expect(run?.steps[0]?.errorType).toBe('DATASOURCE_ACCESS_DENIED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists step results when ResultStore is enabled', async () => {
    const store = new MemoryResultStore();
    h = await makeHarness(
      [
        VALIDATE_OK,
        {
          match: 'SELECT_ROWS',
          pages: [
            {
              columns: [{ name: 'n', type: 'bigint' }],
              data: [[1], [2]],
            },
          ],
        },
      ],
      {},
      undefined,
      store,
    );
    const w = await h.workflows.create('alice', {
      name: 'persist',
      stages: workflowDefinitionSchema.parse([
        { steps: [{ id: 'st_x', name: 'X', statement: 'SELECT_ROWS' }] },
      ]),
      datasourceId: DEFAULT_DATASOURCE_ID,
    });
    const { runId } = await h.runner.runManual(w);
    await h.runner.whenIdle();
    const run = await h.runs.getRun(runId);
    const step = run!.steps[0]!;
    expect(step.resultAvailable).toBe(true);
    expect(step.rowCount).toBe(2);
    const keys = [...store.objects.keys()];
    expect(keys.some((k) => k.includes(runId) && k.includes(step.id))).toBe(true);
  });

  it('aborts orphan runs on start', async () => {
    h = await makeHarness([VALIDATE_OK]);
    const w = await h.workflows.create('alice', {
      name: 'orphan',
      stages: workflowDefinitionSchema.parse([
        { steps: [{ id: 'st_x', name: 'X', statement: 'SELECT 1' }] },
      ]),
      datasourceId: DEFAULT_DATASOURCE_ID,
    });
    const runId = await h.runs.startRun(
      w,
      'manual',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    );
    await h.runner.start();
    const run = await h.runs.getRun(runId);
    expect(run?.status).toBe('aborted');
  });
});
