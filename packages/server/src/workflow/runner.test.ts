import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { workflowDefinitionSchema } from '@hubble/contracts';
import { openMemoryDatabase } from '../db';
import type { SqlDatabase } from '../db/sqlDatabase';
import { EstimateService } from '../query/estimateService';
import { WorkflowRepository, WorkflowRunRepository } from '../store/workflows';
import { DocumentShareRepository } from '../store/documentShares';
import { SavedQueryRepository } from '../store/savedQueries';
import { NotebookRepository } from '../store/notebooks';
import { DocumentGitLinkRepository } from '../github/store';
import { GithubGovernanceService } from '../github/governance';
import { loadServerConfig } from '../config';
import { contentHash, workflowToContent } from '../github/canonical';
import { FakeTrino, type FakeScenario } from '../test/fakeTrino';
import {
  memoryResultStoreValidator,
  memoryResultStoreVersionId,
  readMemoryResultRange,
  validateMemoryResultRequest,
} from '../test/memoryResultStore';
import { loadRbac } from '../rbac/loader';
import type { LoadedRbac } from '../rbac/types';
import { DEFAULT_DATASOURCE_ID, makeEnginesMap } from '../test/testEngine';
import { WorkflowRunner } from './runner';
import { AuditLogger, AuditRepository } from '../audit';
import type { ResultArtifactFormat, ResultStore, ResultStoreRequestOptions } from '../resultStore';
import { NoneResultStore } from '../resultStore';
import { JobAdmissionController } from '../schedule/admission';
import { ResultObjectDeletionRepository } from '../store/resultObjectDeletions';

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

  async stat(key: string, options?: ResultStoreRequestOptions) {
    const data = this.objects.get(key);
    if (!data) throw new Error(`missing ${key}`);
    validateMemoryResultRequest(key, data, options);
    return {
      size: data.length,
      validator: memoryResultStoreValidator(data),
      versionId: memoryResultStoreVersionId(data),
    };
  }

  async readRange(
    key: string,
    offset: number,
    length: number,
    options?: ResultStoreRequestOptions,
  ): Promise<Buffer> {
    const data = this.objects.get(key);
    if (!data) throw new Error(`missing ${key}`);
    return readMemoryResultRange(key, data, offset, length, options);
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async deleteExpired(objects: { key: string }[]) {
    for (const object of objects) this.objects.delete(object.key);
    return { deleted: objects.map((o) => o.key), failed: [] };
  }

  async close(): Promise<void> {}
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class GatedResultStore extends MemoryResultStore {
  private readonly uploadGate = deferred();
  private readonly uploadReached = deferred();

  readonly reachedUpload = this.uploadReached.promise;
  deleteFailure?: Error;

  override async put(key: string, body: Readable, format: ResultArtifactFormat): Promise<void> {
    await super.put(key, body, format);
    this.uploadReached.resolve();
    await this.uploadGate.promise;
  }

  releaseUpload(): void {
    this.uploadGate.resolve();
  }

  override async delete(key: string): Promise<void> {
    if (this.deleteFailure) throw this.deleteFailure;
    await super.delete(key);
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
  resultObjectDeletions: ResultObjectDeletionRepository;
  links: DocumentGitLinkRepository;
  sleeps: number[];
  now: () => number;
  setNow: (ms: number) => void;
}

async function makeHarness(
  scenarios: FakeScenario[],
  configOverrides: {
    guardMode?: 'off' | 'warn' | 'enforce';
    governance?: 'off' | 'on';
    runnerEnabled?: boolean;
    maxConcurrent?: number;
  } = {},
  getRbac?: () => LoadedRbac,
  resultStore?: ResultStore,
  onSleep?: () => void | Promise<void>,
): Promise<Harness> {
  const db = await openMemoryDatabase();
  const fake = new FakeTrino(scenarios);
  const { engines, defaultDatasourceId } = makeEnginesMap(fake);
  const workflows = new WorkflowRepository(db);
  const runs = new WorkflowRunRepository(db, 50);
  const audit = new AuditLogger(new AuditRepository(db));
  const store = resultStore ?? new MemoryResultStore();
  const shares = new DocumentShareRepository(db);
  const savedQueries = new SavedQueryRepository(db, shares);
  const notebooks = new NotebookRepository(db, shares);
  const links = new DocumentGitLinkRepository(db);
  let nowMs = Date.parse('2026-01-01T00:00:00.000Z');
  const now = (): number => nowMs;
  const githubConfig = {
    ...loadServerConfig({
      GITHUB_REPO: 'acme/hubble-docs',
      GITHUB_APP_CLIENT_ID: 'cid',
      GITHUB_APP_CLIENT_SECRET: 'sec',
      GITHUB_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString('base64'),
    }).github,
    governance: configOverrides.governance ?? 'off',
  };
  const githubGovernance = new GithubGovernanceService({
    config: githubConfig,
    links,
    savedQueries,
    notebooks,
    workflows,
    now,
  });
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
  const resultObjectDeletions = new ResultObjectDeletionRepository(db);
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
    resultObjectDeletions,
    resultKeyPrefix: 'hubble-results/',
    resultTtlDays: 7,
    githubGovernance,
    admission: new JobAdmissionController(configOverrides.maxConcurrent ?? 2),
    config: {
      enabled: configOverrides.runnerEnabled ?? false,
      tickSeconds: 15,
      maxConcurrent: configOverrides.maxConcurrent ?? 2,
      runsRetention: 50,
      guardMode: configOverrides.guardMode ?? 'warn',
    },
    now,
    sleep: async (ms) => {
      sleeps.push(ms);
      await onSleep?.();
    },
  });
  return {
    db,
    fake,
    workflows,
    runs,
    runner,
    audit,
    resultStore: store,
    resultObjectDeletions,
    links,
    sleeps,
    now,
    setNow: (ms: number) => {
      nowMs = ms;
    },
  };
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

  it('limits parallel stage statements with the shared admission capacity', async () => {
    const store = new GatedResultStore();
    h = await makeHarness(
      [
        VALIDATE_OK,
        {
          match: 'LIMITED_A',
          pages: [{ columns: [{ name: 'n', type: 'bigint' }], data: [[1]] }],
        },
        {
          match: 'LIMITED_B',
          pages: [{ columns: [{ name: 'n', type: 'bigint' }], data: [[2]] }],
        },
      ],
      { maxConcurrent: 1 },
      undefined,
      store,
    );
    const workflow = await h.workflows.create('alice', {
      name: 'bounded stage',
      stages: workflowDefinitionSchema.parse([
        {
          steps: [
            { id: 'st_a', name: 'A', statement: 'LIMITED_A' },
            { id: 'st_b', name: 'B', statement: 'LIMITED_B' },
          ],
        },
      ]),
      datasourceId: DEFAULT_DATASOURCE_ID,
    });

    const { runId } = await h.runner.runManual(workflow);
    await store.reachedUpload;
    expect(executedStatements(h.fake)).toHaveLength(1);
    store.releaseUpload();
    await h.runner.whenIdle();

    expect(executedStatements(h.fake)).toHaveLength(2);
    expect((await h.runs.getRun(runId))?.status).toBe('success');
  });

  it('waits for a manual workflow that is still creating its DB claim', async () => {
    h = await makeHarness([VALIDATE_OK]);
    const workflow = await h.workflows.create('alice', {
      name: 'claim pending',
      stages: workflowDefinitionSchema.parse([
        { steps: [{ id: 'st_pending', name: 'Pending', statement: 'SELECT 1' }] },
      ]),
      datasourceId: DEFAULT_DATASOURCE_ID,
    });
    const gate = deferred();
    const startReached = deferred();
    const originalStart = h.runs.startRun.bind(h.runs);
    const start = vi.spyOn(h.runs, 'startRun').mockImplementation(async (...args) => {
      startReached.resolve();
      await gate.promise;
      return originalStart(...args);
    });

    const manual = h.runner.runManual(workflow);
    await startReached.promise;
    let stopped = false;
    const stopping = h.runner.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    gate.resolve();
    const { runId } = await manual;
    await stopping;
    const run = await h.runs.getRun(runId);
    expect(run?.status).toBe('aborted');
    expect(run?.steps[0]?.status).toBe('skipped');
    start.mockRestore();
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
        { steps: [{ id: 'st_x', name: 'X', statement: 'SELECT 1 /* SELECT_FLAKY */' }] },
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

  it('records an aborted run when shutdown interrupts retry backoff', async () => {
    const sleepGate = deferred();
    h = await makeHarness(
      [
        VALIDATE_OK,
        {
          match: 'BACKOFF_ABORT',
          error: { message: 'temporary failure', errorType: 'INTERNAL_ERROR' },
        },
      ],
      {},
      undefined,
      new NoneResultStore(),
      () => sleepGate.promise,
    );
    const workflow = await h.workflows.create('alice', {
      name: 'backoff abort',
      stages: workflowDefinitionSchema.parse([
        {
          steps: [{ id: 'st_abort', name: 'Abort', statement: 'SELECT 1 /* BACKOFF_ABORT */' }],
        },
      ]),
      retry: { maxAttempts: 3, backoffSeconds: 30, backoffMultiplier: 2 },
      datasourceId: DEFAULT_DATASOURCE_ID,
    });
    const { runId } = await h.runner.runManual(workflow);
    await vi.waitFor(() => expect(h.sleeps).toEqual([30_000]));

    await h.runner.stop();
    const run = await h.runs.getRun(runId);
    expect(run?.status).toBe('aborted');
    expect(run?.steps[0]?.status).toBe('aborted');
    sleepGate.resolve();
  });

  it('does not retry a write step after the engine accepts it and loses the response', async () => {
    h = await makeHarness([
      VALIDATE_OK,
      {
        match: 'WRITE_RESPONSE_LOST',
        transportError: {
          message: 'response lost after commit',
          status: 503,
        },
      },
    ]);
    const workflow = await h.workflows.create('alice', {
      name: 'write once',
      stages: workflowDefinitionSchema.parse([
        {
          steps: [
            {
              id: 'st_write',
              name: 'Write',
              statement: 'UPDATE audit_log SET value = 1 /* WRITE_RESPONSE_LOST */',
            },
          ],
        },
      ]),
      retry: { maxAttempts: 3, backoffSeconds: 30, backoffMultiplier: 2 },
      datasourceId: DEFAULT_DATASOURCE_ID,
    });

    const { runId } = await h.runner.runManual(workflow);
    await h.runner.whenIdle();

    const acceptedWrites = h.fake.requests.filter(
      (request) =>
        request.method === 'POST' &&
        request.body?.includes('WRITE_RESPONSE_LOST') &&
        !request.body.startsWith('EXPLAIN'),
    );
    const run = await h.runs.getRun(runId);
    expect(acceptedWrites).toHaveLength(1);
    expect(run?.status).toBe('failed');
    expect(run?.steps[0]?.attempt).toBe(1);
    expect(h.sleeps).toEqual([]);
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

  it('step result の DB 関連付けに失敗した場合は upload 済み object を削除する', async () => {
    const store = new MemoryResultStore();
    h = await makeHarness(
      [
        VALIDATE_OK,
        {
          match: 'LINK_FAILURE',
          pages: [{ columns: [{ name: 'n', type: 'bigint' }], data: [[1]] }],
        },
      ],
      {},
      undefined,
      store,
    );
    const workflow = await h.workflows.create('alice', {
      name: 'link failure cleanup',
      stages: workflowDefinitionSchema.parse([
        { steps: [{ id: 'st_link', name: 'Link', statement: 'LINK_FAILURE' }] },
      ]),
      datasourceId: DEFAULT_DATASOURCE_ID,
    });
    const linkError = new Error('DB link failed');
    vi.spyOn(h.runs, 'finishStep').mockRejectedValueOnce(linkError);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await h.runner.runManual(workflow);
    await h.runner.whenIdle();

    expect(store.objects.size).toBe(0);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('unexpected error in manual run'),
      linkError,
    );
    log.mockRestore();
  });

  it('finishStep の commit 応答だけを失った場合は live object を削除しない', async () => {
    const store = new MemoryResultStore();
    h = await makeHarness(
      [
        VALIDATE_OK,
        {
          match: 'LINK_RESPONSE_LOST',
          pages: [{ columns: [{ name: 'n', type: 'bigint' }], data: [[1]] }],
        },
      ],
      {},
      undefined,
      store,
    );
    const workflow = await h.workflows.create('alice', {
      name: 'link response lost',
      stages: workflowDefinitionSchema.parse([
        { steps: [{ id: 'st_link', name: 'Link', statement: 'LINK_RESPONSE_LOST' }] },
      ]),
      datasourceId: DEFAULT_DATASOURCE_ID,
    });
    const finishStep = h.runs.finishStep.bind(h.runs);
    const responseLost = new Error('commit response lost');
    vi.spyOn(h.runs, 'finishStep').mockImplementationOnce(async (...args) => {
      await finishStep(...args);
      throw responseLost;
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { runId } = await h.runner.runManual(workflow);
    await h.runner.whenIdle();

    const step = (await h.runs.getRun(runId))!.steps[0]!;
    const storedStep = await h.runs.getStepRun(runId, step.id);
    const key = [...store.objects.keys()][0]!;
    expect(storedStep?.resultObjectKey).toBe(key);
    expect(store.objects.has(key)).toBe(true);
    expect(await h.resultObjectDeletions.listForTest()).toEqual([]);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('unexpected error in manual run'),
      responseLost,
    );
    log.mockRestore();
  });

  it('does not record success when shutdown arrives during result upload', async () => {
    const store = new GatedResultStore();
    h = await makeHarness(
      [
        VALIDATE_OK,
        {
          match: 'UPLOAD_ABORT',
          pages: [{ columns: [{ name: 'n', type: 'bigint' }], data: [[1]] }],
        },
      ],
      {},
      undefined,
      store,
    );
    const workflow = await h.workflows.create('alice', {
      name: 'upload abort',
      stages: workflowDefinitionSchema.parse([
        { steps: [{ id: 'st_upload', name: 'Upload', statement: 'UPLOAD_ABORT' }] },
      ]),
      datasourceId: DEFAULT_DATASOURCE_ID,
    });
    const { runId } = await h.runner.runManual(workflow);
    await store.reachedUpload;

    const stopping = h.runner.stop();
    store.releaseUpload();
    await stopping;

    const run = await h.runs.getRun(runId);
    expect(run?.status).toBe('aborted');
    expect(run?.steps[0]?.status).toBe('aborted');
    expect(run?.steps[0]?.resultAvailable).toBe(false);
    expect(store.objects.size).toBe(0);
  });

  it('削除に失敗した中断 result を durable outbox へ登録する', async () => {
    const store = new GatedResultStore();
    store.deleteFailure = new Error('S3 delete unavailable');
    h = await makeHarness(
      [
        VALIDATE_OK,
        {
          match: 'UPLOAD_DELETE_FAIL',
          pages: [{ columns: [{ name: 'n', type: 'bigint' }], data: [[1]] }],
        },
      ],
      {},
      undefined,
      store,
    );
    const workflow = await h.workflows.create('alice', {
      name: 'upload delete fail',
      stages: workflowDefinitionSchema.parse([
        {
          steps: [
            { id: 'st_upload', name: 'Upload', statement: 'SELECT 1 /* UPLOAD_DELETE_FAIL */' },
          ],
        },
      ]),
      datasourceId: DEFAULT_DATASOURCE_ID,
    });
    const { runId } = await h.runner.runManual(workflow);
    await store.reachedUpload;

    const stopping = h.runner.stop();
    store.releaseUpload();
    await stopping;

    const run = await h.runs.getRun(runId);
    const step = run!.steps[0]!;
    expect(run?.status).toBe('aborted');
    expect(step.status).toBe('aborted');
    expect(step.resultAvailable).toBe(false);
    expect(await h.resultObjectDeletions.listForTest()).toEqual([
      expect.objectContaining({ key: [...store.objects.keys()][0] }),
    ]);
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

describe('WorkflowRunner GitHub governance', () => {
  let h: Harness;
  afterEach(async () => {
    if (h?.db) await h.db.close();
  });

  it('blocks unapproved workflow on cron with skipped steps and no execution', async () => {
    h = await makeHarness(
      [
        VALIDATE_OK,
        {
          match: 'SELECT_GOV',
          pages: [{ columns: [{ name: 'n', type: 'bigint' }], data: [[1]] }],
        },
      ],
      { governance: 'on', runnerEnabled: true },
    );
    const w = await h.workflows.create('alice', {
      name: 'cron-gov',
      cron: '* * * * *',
      stages: workflowDefinitionSchema.parse([
        { steps: [{ id: 'st_x', name: 'X', statement: 'SELECT_GOV' }] },
      ]),
      datasourceId: DEFAULT_DATASOURCE_ID,
    });
    await h.runner.start();
    await h.runner.tick();
    expect(await h.runs.listRuns(w.id, 10)).toHaveLength(0);
    h.setNow(h.now() + 61_000);
    await h.runner.tick();
    await h.runner.whenIdle();
    const runs = await h.runs.listRuns(w.id, 10);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('blocked');
    const detail = await h.runs.getRun(runs[0]!.id);
    expect(detail?.steps.every((s) => s.status === 'skipped')).toBe(true);
    expect(executedStatements(h.fake)).toHaveLength(0);
    const auditRows = await h.audit.listForTest();
    expect(
      auditRows.some((row) => {
        const detail = row.detail;
        return (
          detail !== null &&
          typeof detail === 'object' &&
          !Array.isArray(detail) &&
          detail.governance === 'blocked'
        );
      }),
    ).toBe(true);
  });

  it('runs manual unapproved workflow without persisting step results', async () => {
    const store = new MemoryResultStore();
    h = await makeHarness(
      [
        VALIDATE_OK,
        {
          match: 'SELECT_GOV_MANUAL',
          pages: [{ columns: [{ name: 'n', type: 'bigint' }], data: [[1], [2]] }],
        },
      ],
      { governance: 'on' },
      undefined,
      store,
    );
    const w = await h.workflows.create('alice', {
      name: 'manual-gov',
      stages: workflowDefinitionSchema.parse([
        { steps: [{ id: 'st_x', name: 'X', statement: 'SELECT_GOV_MANUAL' }] },
      ]),
      datasourceId: DEFAULT_DATASOURCE_ID,
    });
    const { runId } = await h.runner.runManual(w);
    await h.runner.whenIdle();
    const run = await h.runs.getRun(runId);
    expect(run?.status).toBe('success');
    expect(run?.steps[0]?.resultAvailable).toBe(false);
    expect(store.objects.size).toBe(0);
    expect(executedStatements(h.fake)).toContain('SELECT_GOV_MANUAL');
  });

  it('persists step results for approved workflow under governance', async () => {
    const store = new MemoryResultStore();
    h = await makeHarness(
      [
        VALIDATE_OK,
        {
          match: 'SELECT_GOV_OK',
          pages: [{ columns: [{ name: 'n', type: 'bigint' }], data: [[1]] }],
        },
      ],
      { governance: 'on' },
      undefined,
      store,
    );
    const w = await h.workflows.create('alice', {
      name: 'approved',
      stages: workflowDefinitionSchema.parse([
        { steps: [{ id: 'st_x', name: 'X', statement: 'SELECT_GOV_OK' }] },
      ]),
      datasourceId: DEFAULT_DATASOURCE_ID,
    });
    await h.links.upsert('workflow', w.id, {
      path: `workflows/${w.id}.yaml`,
      approvedHash: contentHash(workflowToContent(w)),
    });
    const { runId } = await h.runner.runManual(w);
    await h.runner.whenIdle();
    const run = await h.runs.getRun(runId);
    expect(run?.status).toBe('success');
    expect(run?.steps[0]?.resultAvailable).toBe(true);
    expect(store.objects.size).toBeGreaterThan(0);
  });
});
