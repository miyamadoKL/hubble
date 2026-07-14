import { afterEach, describe, expect, it, vi } from 'vitest';
import { openMemoryDatabase } from '../db';
import type { SqlDatabase } from '../db/sqlDatabase';
import { EstimateService } from '../query/estimateService';
import { ScheduleRepository, ScheduleRunRepository } from '../store/schedules';
import { FakeTrino, type FakeScenario } from '../test/fakeTrino';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadRbac } from '../rbac/loader';
import type { LoadedRbac } from '../rbac/types';
import { DEFAULT_DATASOURCE_ID, makeEnginesMap } from '../test/testEngine';
import { LeasedEngine } from '../engine/leasedEngine';
import type { QueryEngine } from '../engine/types';
import { Scheduler, type SchedulerConfig } from './scheduler';
import { AuditLogger, AuditRepository } from '../audit';
import type { FailureNotificationInput, FailureNotificationSender } from '../notification/service';
import { JobAdmissionController } from './admission';

const DEFAULT_GUARD_CONFIG = {
  mode: 'warn' as const,
  maxScanBytes: 0,
  maxScanRows: 100,
  onUnknown: 'warn' as const,
  estimateTimeoutMs: 3000,
  cacheTtlSeconds: 0,
  bytesPerSecond: 0,
};

const TEST_RBAC: LoadedRbac = {
  roles: new Map([
    ['unrestricted', { permissions: new Set(['query.write', 'ai.use']), datasources: ['*'] }],
  ]),
  assignments: [],
  defaultRole: 'unrestricted',
};

/**
 * Scheduler behavior matrix (Query Scheduling feature). Each statement marker is
 * exercised through three Trino calls — `EXPLAIN (TYPE VALIDATE) <stmt>`
 * (validation), optionally `EXPLAIN (TYPE IO, FORMAT JSON) <stmt>` (guard), and
 * the bare `<stmt>` (execution). FakeTrino matches scenarios by substring in
 * registration order, so EXPLAIN-prefixed scenarios are registered before the
 * bare-statement scenario.
 */

const VALIDATE_OK: FakeScenario = {
  // Any `EXPLAIN (TYPE VALIDATE) ...` succeeds with the [[true]] cell.
  match: 'EXPLAIN (TYPE VALIDATE)',
  pages: [{ columns: [{ name: 'result', type: 'boolean' }], data: [[true]] }],
};

/** SQL の接頭辞を手書きせず、marker 一致で validation 失敗を作る。 */
function validationFailure(marker: string, message: string): FakeScenario {
  return {
    match: marker,
    error: { message, errorName: 'VALIDATION_ERROR', errorType: 'USER_ERROR' },
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** An EXPLAIN IO plan cell whose single input table scans `rows` rows. */
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

interface Harness {
  db: SqlDatabase;
  fake: FakeTrino;
  engines: Map<string, QueryEngine>;
  schedules: ScheduleRepository;
  runs: ScheduleRunRepository;
  scheduler: Scheduler;
  admission: JobAdmissionController;
  audit: AuditLogger;
  notifications: FailureNotificationInput[];
  sleeps: number[];
  now: () => number;
  setNow: (ms: number) => void;
}

async function makeHarness(
  scenarios: FakeScenario[],
  configOverrides: Partial<SchedulerConfig> = {},
  /** Invoked on each retry backoff sleep (e.g. to swap scenarios mid-run). */
  onSleep?: (callIndex: number, ms: number) => void | Promise<void>,
  getRbac?: () => LoadedRbac,
  notificationSender?: FailureNotificationSender,
): Promise<Harness> {
  const db = await openMemoryDatabase();
  const fake = new FakeTrino(scenarios);
  const { engines, defaultDatasourceId } = makeEnginesMap(fake);
  const schedules = new ScheduleRepository(db);
  const runs = new ScheduleRunRepository(db, 50);
  const audit = new AuditLogger(new AuditRepository(db));
  const notifications: FailureNotificationInput[] = [];
  const notifier =
    notificationSender ??
    ({
      sendFailure: async (input) => {
        notifications.push(input);
      },
    } satisfies FailureNotificationSender);
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
  let nowMs = Date.parse('2026-01-01T00:00:00.000Z');
  const now = (): number => nowMs;
  const config: SchedulerConfig = {
    enabled: false,
    tickSeconds: 15,
    maxConcurrent: 2,
    runsRetention: 50,
    guardMode: 'warn',
    ...configOverrides,
  };
  const admission = new JobAdmissionController(config.maxConcurrent);
  const scheduler = new Scheduler({
    schedules,
    runs,
    engines,
    defaultDatasourceId,
    estimate,
    getRbac: getRbac ?? (() => TEST_RBAC),
    guardConfig: {
      ...DEFAULT_GUARD_CONFIG,
      mode: configOverrides.guardMode ?? DEFAULT_GUARD_CONFIG.mode,
    },
    audit,
    notifications: notifier,
    admission,
    config,
    now,
    sleep: async (ms) => {
      const sleepResult = onSleep?.(sleeps.length, ms);
      sleeps.push(ms);
      await sleepResult;
    },
  });
  return {
    db,
    fake,
    engines,
    schedules,
    runs,
    scheduler,
    admission,
    audit,
    notifications,
    sleeps,
    now,
    setNow: (ms) => {
      nowMs = ms;
    },
  };
}

describe('Scheduler run matrix', () => {
  let h: Harness;
  afterEach(async () => {
    if (h?.db) await h.db.close();
  });

  it('records a successful run with row_count and trino_query_id', async () => {
    h = await makeHarness([
      VALIDATE_OK,
      {
        match: 'SELECT_OK',
        trinoId: 'qok',
        pages: [{ columns: [{ name: 'n', type: 'bigint' }], data: [[1]] }],
      },
    ]);
    const s = await h.schedules.create('alice', {
      name: 'ok',
      statement: 'SELECT_OK',
      cron: '* * * * *',
      datasourceId: DEFAULT_DATASOURCE_ID,

      principalSnapshot: { user: 'alice' },
    });
    const { runId } = await h.scheduler.runManual(s);
    await h.scheduler.whenIdle();

    const runs = await h.runs.list(s.id, 10);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.id).toBe(runId);
    expect(runs[0]!.status).toBe('success');
    expect(runs[0]!.attempt).toBe(1);
    expect(runs[0]!.rowCount).toBe(1);
    expect(runs[0]!.trinoQueryId).toMatch(/^qok_/);
    expect(runs[0]!.errorType).toBeNull();

    const auditRows = await h.audit.listForTest();
    const runAudit = auditRows.find((row) => row.action === 'schedule.execute');
    expect(runAudit).toMatchObject({
      actor: 'alice',
      target: s.id,
      datasource: DEFAULT_DATASOURCE_ID,
    });
    expect(runAudit?.detail).toMatchObject({
      scheduleId: s.id,
      runOwner: 'alice',
      outcome: 'success',
      success: true,
      trinoQueryId: expect.stringMatching(/^qok_/),
      rowCount: 1,
    });
    expect(h.notifications).toHaveLength(0);
  });

  it('keeps the engine open while a background run holds its lease', async () => {
    h = await makeHarness([
      VALIDATE_OK,
      {
        match: 'SELECT_LEASED',
        trinoId: 'qleased',
        pages: [{ columns: [{ name: 'n', type: 'bigint' }], data: [[1]] }],
      },
    ]);
    const inner = h.engines.get(DEFAULT_DATASOURCE_ID)!;
    const closeInner = vi.spyOn(inner, 'close');
    const leased = new LeasedEngine(inner);
    h.engines.set(DEFAULT_DATASOURCE_ID, leased);
    let releaseAdvance!: () => void;
    h.fake.holdAdvance = new Promise<void>((resolve) => {
      releaseAdvance = resolve;
    });
    const schedule = await h.schedules.create('alice', {
      name: 'leased',
      statement: 'SELECT_LEASED',
      cron: '* * * * *',
      datasourceId: DEFAULT_DATASOURCE_ID,

      principalSnapshot: { user: 'alice' },
    });

    await h.scheduler.runManual(schedule);
    await vi.waitFor(() => expect(h.fake.activeCount).toBe(1));
    const closing = leased.close();
    await Promise.resolve();
    expect(closeInner).not.toHaveBeenCalled();

    releaseAdvance();
    await h.scheduler.whenIdle();
    await closing;
    expect(closeInner).toHaveBeenCalledOnce();
    const runs = await h.runs.list(schedule.id, 10);
    expect(runs[0]?.status).toBe('success');
  });

  it('does not notify when a run succeeds even if failure notifications are enabled', async () => {
    h = await makeHarness([
      VALIDATE_OK,
      {
        match: 'SELECT_OK_NOTIFY',
        trinoId: 'qoknotify',
        pages: [{ columns: [{ name: 'n', type: 'bigint' }], data: [[1]] }],
      },
    ]);
    const s = await h.schedules.create('alice', {
      name: 'ok notify',
      statement: 'SELECT_OK_NOTIFY',
      cron: '* * * * *',
      notifications: { onFailure: true, channels: ['slack'] },
      datasourceId: DEFAULT_DATASOURCE_ID,

      principalSnapshot: { user: 'alice' },
    });
    await h.scheduler.runManual(s);
    await h.scheduler.whenIdle();

    const runs = await h.runs.list(s.id, 10);
    expect(runs[0]!.status).toBe('success');
    expect(h.notifications).toHaveLength(0);
  });

  it('waits for an in-flight failure notification during stop', async () => {
    let notificationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notificationStarted = resolve;
    });
    let releaseNotification!: () => void;
    const notificationGate = new Promise<void>((resolve) => {
      releaseNotification = resolve;
    });
    h = await makeHarness([validationFailure('NOTIFY_FAIL', 'invalid')], {}, undefined, undefined, {
      sendFailure: async () => {
        notificationStarted();
        await notificationGate;
      },
    });
    const schedule = await h.schedules.create('alice', {
      name: 'notify fail',
      statement: 'SELECT 1 /* NOTIFY_FAIL */',
      cron: '* * * * *',
      retry: { maxAttempts: 1, backoffSeconds: 1, backoffMultiplier: 1 },
      notifications: { onFailure: true, channels: ['slack'] },
      datasourceId: DEFAULT_DATASOURCE_ID,

      principalSnapshot: { user: 'alice' },
    });
    await h.scheduler.runManual(schedule);
    await started;

    let stopped = false;
    const stopping = h.scheduler.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    releaseNotification();
    await stopping;
    expect(stopped).toBe(true);
  });

  it('waits for a manual run that is still creating its DB claim', async () => {
    h = await makeHarness([VALIDATE_OK]);
    const schedule = await h.schedules.create('alice', {
      name: 'claim pending',
      statement: 'SELECT 1',
      cron: '* * * * *',
      datasourceId: DEFAULT_DATASOURCE_ID,

      principalSnapshot: { user: 'alice' },
    });
    const gate = deferred();
    const startReached = deferred();
    const originalStart = h.runs.start.bind(h.runs);
    const start = vi.spyOn(h.runs, 'start').mockImplementation(async (input) => {
      startReached.resolve();
      await gate.promise;
      return originalStart(input);
    });

    const manual = h.scheduler.runManual(schedule);
    await startReached.promise;
    let stopped = false;
    const stopping = h.scheduler.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    gate.resolve();
    const { runId } = await manual;
    await stopping;
    const run = (await h.runs.list(schedule.id, 10)).find((item) => item.id === runId);
    expect(run?.status).toBe('aborted');
    start.mockRestore();
  });

  it('fails immediately on a USER_ERROR (validation) with no retry', async () => {
    h = await makeHarness([
      {
        match: 'EXPLAIN (TYPE VALIDATE) SELECT_BAD',
        error: {
          message: "line 1:8: mismatched input 'FROM'",
          errorName: 'SYNTAX_ERROR',
          errorType: 'USER_ERROR',
          errorLocation: { lineNumber: 1, columnNumber: 8 },
        },
      },
    ]);
    const s = await h.schedules.create('alice', {
      name: 'bad',
      statement: 'SELECT_BAD',
      cron: '* * * * *',
      retry: { maxAttempts: 5, backoffSeconds: 60, backoffMultiplier: 2 },
      datasourceId: DEFAULT_DATASOURCE_ID,

      principalSnapshot: { user: 'alice' },
    });
    await h.scheduler.runManual(s);
    await h.scheduler.whenIdle();

    const runs = await h.runs.list(s.id, 10);
    expect(runs[0]!.status).toBe('failed');
    expect(runs[0]!.errorType).toBe('USER_ERROR');
    expect(runs[0]!.attempt).toBe(1);
    expect(runs[0]!.errorMessage).toContain('mismatched input');
    expect(h.sleeps).toHaveLength(0); // no retry waits
    const auditRows = await h.audit.listForTest();
    const runAudit = auditRows.find((row) => row.action === 'schedule.execute');
    expect(runAudit?.detail).toMatchObject({
      scheduleId: s.id,
      outcome: 'failed',
      success: false,
      errorType: 'USER_ERROR',
      rowCount: null,
      trinoQueryId: null,
    });
  });

  it('retries a transient failure, then succeeds on the next attempt', async () => {
    const flakyFail: FakeScenario = {
      match: 'SELECT_FLAKY',
      trinoId: 'qflaky',
      error: {
        message: 'temporary engine fault',
        errorName: 'GENERIC_INTERNAL_ERROR',
        errorType: 'INTERNAL_ERROR',
      },
    };
    const flakyOk: FakeScenario = {
      match: 'SELECT_FLAKY',
      trinoId: 'qflakyok',
      pages: [{ columns: [{ name: 'n', type: 'bigint' }], data: [[1]] }],
    };
    // On the first (and only) backoff sleep, swap the failing scenario for a
    // succeeding one so the retry attempt completes. A holder lets the onSleep
    // closure reach the fake created just below.
    const holder: { fake?: FakeTrino } = {};
    h = await makeHarness([VALIDATE_OK, flakyFail], {}, () => {
      holder.fake?.setScenarios([VALIDATE_OK, flakyOk]);
    });
    holder.fake = h.fake;
    const s = await h.schedules.create('alice', {
      name: 'flaky',
      statement: 'SELECT 1 /* SELECT_FLAKY */',
      cron: '* * * * *',
      retry: { maxAttempts: 3, backoffSeconds: 30, backoffMultiplier: 2 },
      notifications: { onFailure: true, channels: ['slack'] },
      datasourceId: DEFAULT_DATASOURCE_ID,

      principalSnapshot: { user: 'alice' },
    });
    await h.scheduler.runManual(s);
    await h.scheduler.whenIdle();

    const runs = await h.runs.list(s.id, 10);
    expect(runs[0]!.status).toBe('success');
    expect(runs[0]!.attempt).toBe(2); // failed once, succeeded on retry
    expect(runs[0]!.rowCount).toBe(1);
    expect(runs[0]!.trinoQueryId).toMatch(/^qflakyok_/);
    expect(h.sleeps).toEqual([30_000]); // one backoff before the single retry
    expect(h.notifications).toHaveLength(0);
  });

  it('records an aborted run when shutdown interrupts retry backoff', async () => {
    let releaseSleep!: () => void;
    const sleepGate = new Promise<void>((resolve) => {
      releaseSleep = resolve;
    });
    h = await makeHarness(
      [
        VALIDATE_OK,
        {
          match: 'BACKOFF_ABORT',
          error: { message: 'temporary failure', errorType: 'INTERNAL_ERROR' },
        },
      ],
      {},
      () => sleepGate,
    );
    const schedule = await h.schedules.create('alice', {
      name: 'backoff abort',
      statement: 'SELECT 1 /* BACKOFF_ABORT */',
      cron: '* * * * *',
      retry: { maxAttempts: 3, backoffSeconds: 30, backoffMultiplier: 2 },
      datasourceId: DEFAULT_DATASOURCE_ID,

      principalSnapshot: { user: 'alice' },
    });
    const { runId } = await h.scheduler.runManual(schedule);
    await vi.waitFor(() => expect(h.sleeps).toEqual([30_000]));

    await h.scheduler.stop();
    const run = (await h.runs.list(schedule.id, 10)).find((item) => item.id === runId);
    expect(run?.status).toBe('aborted');
    expect(run?.errorType).toBe('SERVER_SHUTDOWN');
    releaseSleep();
  });

  it('does not retry a write after the engine accepts it and loses the response', async () => {
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
    const schedule = await h.schedules.create('alice', {
      name: 'write once',
      statement: 'INSERT INTO audit_log VALUES (1) /* WRITE_RESPONSE_LOST */',
      cron: '* * * * *',
      retry: { maxAttempts: 3, backoffSeconds: 30, backoffMultiplier: 2 },
      datasourceId: DEFAULT_DATASOURCE_ID,

      principalSnapshot: { user: 'alice' },
    });

    await h.scheduler.runManual(schedule);
    await h.scheduler.whenIdle();

    const acceptedWrites = h.fake.requests.filter(
      (request) =>
        request.method === 'POST' &&
        request.body?.includes('WRITE_RESPONSE_LOST') &&
        !request.body.startsWith('EXPLAIN'),
    );
    const run = (await h.runs.list(schedule.id, 10))[0]!;
    expect(acceptedWrites).toHaveLength(1);
    expect(run.status).toBe('failed');
    expect(run.attempt).toBe(1);
    expect(h.sleeps).toEqual([]);
  });

  it('fails after exhausting maxAttempts on a persistent transient fault', async () => {
    h = await makeHarness([
      VALIDATE_OK,
      {
        match: 'SELECT_DOWN',
        error: {
          message: 'temporary engine fault',
          errorName: 'GENERIC_INTERNAL_ERROR',
          errorType: 'INTERNAL_ERROR',
        },
      },
    ]);
    const s = await h.schedules.create('alice', {
      name: 'down',
      statement: 'SELECT 1 /* SELECT_DOWN */',
      cron: '* * * * *',
      retry: { maxAttempts: 3, backoffSeconds: 30, backoffMultiplier: 2 },
      notifications: { onFailure: true, channels: ['slack'] },
      datasourceId: DEFAULT_DATASOURCE_ID,

      principalSnapshot: { user: 'alice' },
    });
    await h.scheduler.runManual(s);
    await h.scheduler.whenIdle();

    const runs = await h.runs.list(s.id, 10);
    expect(runs[0]!.status).toBe('failed');
    expect(runs[0]!.errorType).toBe('INTERNAL_ERROR');
    expect(runs[0]!.attempt).toBe(3);
    // Two backoff waits between three attempts: 30s and 60s.
    expect(h.sleeps).toEqual([30_000, 60_000]);
    expect(h.notifications).toHaveLength(1);
    expect(h.notifications[0]).toMatchObject({
      schedule: { id: s.id, name: 'down', owner: 'alice' },
      runId: runs[0]!.id,
      errorType: 'INTERNAL_ERROR',
      errorMessage: 'temporary engine fault',
    });
  });

  it('blocks schedule runs when owner role cannot access datasourceId', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hubble-sched-rbac-'));
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
      const rbac = () => loadRbac({ env: { RBAC_PATH: join(dir, 'rbac.yaml') }, cwd: dir });
      h = await makeHarness([VALIDATE_OK], {}, undefined, rbac);
      const s = await h.schedules.create('alice', {
        name: 'denied',
        statement: 'SELECT 1',
        cron: '* * * * *',
        datasourceId: DEFAULT_DATASOURCE_ID,

        principalSnapshot: { user: 'alice' },
      });
      await h.scheduler.runManual(s);
      await h.scheduler.whenIdle();

      const runs = await h.runs.list(s.id, 10);
      expect(runs[0]!.status).toBe('blocked');
      expect(runs[0]!.errorType).toBe('DATASOURCE_ACCESS_DENIED');
      expect(runs[0]!.attempt).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('blocks a historical schedule when its principal snapshot is missing', async () => {
    h = await makeHarness([VALIDATE_OK]);
    const schedule = await h.schedules.create('alice', {
      name: 'missing snapshot',
      statement: 'SELECT 1',
      cron: '* * * * *',
      datasourceId: DEFAULT_DATASOURCE_ID,
      principalSnapshot: { user: 'alice' },
    });
    await h.db.run('UPDATE schedules SET principal_snapshot = NULL WHERE id = ?', [schedule.id]);
    const historical = await h.schedules.getById(schedule.id);
    expect(historical?.principalSnapshot).toBeNull();

    await h.scheduler.runManual(historical!);
    await h.scheduler.whenIdle();

    const [run] = await h.runs.list(schedule.id, 10);
    expect(run).toMatchObject({
      status: 'blocked',
      errorType: 'PRINCIPAL_SNAPSHOT_REQUIRED',
    });
    expect(h.fake.activeCount).toBe(0);
  });

  it('blocks (no retry) when Query Guard enforce decides block', async () => {
    h = await makeHarness(
      [
        VALIDATE_OK,
        {
          // EXPLAIN IO returns a plan scanning 1000 rows (> maxScanRows 100).
          match: 'EXPLAIN (TYPE IO, FORMAT JSON) SELECT_BIG',
          pages: [{ columns: [{ name: 'plan', type: 'varchar' }], data: [[ioPlan(1000)]] }],
        },
        {
          match: 'SELECT_BIG',
          pages: [{ columns: [{ name: 'n', type: 'bigint' }], data: [[1]] }],
        },
      ],
      { guardMode: 'enforce' },
    );
    const s = await h.schedules.create('alice', {
      name: 'big',
      statement: 'SELECT_BIG',
      cron: '* * * * *',
      retry: { maxAttempts: 5, backoffSeconds: 60, backoffMultiplier: 2 },
      datasourceId: DEFAULT_DATASOURCE_ID,

      principalSnapshot: { user: 'alice' },
    });
    await h.scheduler.runManual(s);
    await h.scheduler.whenIdle();

    const runs = await h.runs.list(s.id, 10);
    expect(runs[0]!.status).toBe('blocked');
    expect(runs[0]!.errorType).toBe('QUERY_BLOCKED');
    expect(runs[0]!.attempt).toBe(1);
    expect(h.sleeps).toHaveLength(0);
    const auditRows = await h.audit.listForTest();
    const runAudit = auditRows.find((row) => row.action === 'schedule.execute');
    expect(runAudit?.detail).toMatchObject({
      scheduleId: s.id,
      outcome: 'blocked',
      success: false,
      errorType: 'QUERY_BLOCKED',
      rowCount: null,
      trinoQueryId: null,
      guard: {
        decision: 'block',
        scanRows: 1000,
      },
    });
  });
});

describe('Scheduler overlap and concurrency', () => {
  let h: Harness;
  afterEach(async () => {
    if (h?.db) await h.db.close();
  });

  it('rejects a manual run when one is already in flight (overlap)', async () => {
    // Hold the execution so the first run stays in flight.
    h = await makeHarness([
      VALIDATE_OK,
      {
        match: 'SELECT_HOLD',
        pages: [{ columns: [{ name: 'n', type: 'bigint' }], data: [[1]] }],
      },
    ]);
    h.fake.holdAdvance = new Promise(() => {}); // never resolves
    const s = await h.schedules.create('alice', {
      name: 'hold',
      statement: 'SELECT_HOLD',
      cron: '* * * * *',
      datasourceId: DEFAULT_DATASOURCE_ID,

      principalSnapshot: { user: 'alice' },
    });
    await h.scheduler.runManual(s);
    // Second manual run must be rejected while the first is in flight.
    await expect(h.scheduler.runManual(s)).rejects.toThrow(/in progress/);
    expect(h.scheduler.activeRuns).toBe(1);
  });

  it('rejects a different manual run when the shared capacity is one', async () => {
    h = await makeHarness(
      [
        VALIDATE_OK,
        {
          match: 'SELECT_HOLD',
          pages: [{ columns: [{ name: 'n', type: 'bigint' }], data: [[1]] }],
        },
      ],
      { maxConcurrent: 1 },
    );
    let releaseAdvance!: () => void;
    h.fake.holdAdvance = new Promise<void>((resolve) => {
      releaseAdvance = resolve;
    });
    const first = await h.schedules.create('alice', {
      name: 'first',
      statement: 'SELECT 1 /* SELECT_HOLD first */',
      cron: '* * * * *',
      datasourceId: DEFAULT_DATASOURCE_ID,

      principalSnapshot: { user: 'alice' },
    });
    const second = await h.schedules.create('alice', {
      name: 'second',
      statement: 'SELECT 2 /* SELECT_HOLD second */',
      cron: '* * * * *',
      datasourceId: DEFAULT_DATASOURCE_ID,

      principalSnapshot: { user: 'alice' },
    });

    await h.scheduler.runManual(first);
    await vi.waitFor(() => expect(h.fake.activeCount).toBe(1));
    await expect(h.scheduler.runManual(second)).rejects.toMatchObject({ reason: 'capacity' });

    releaseAdvance();
    await h.scheduler.whenIdle();
    expect(h.scheduler.activeRuns).toBe(0);
  });
});

describe('Scheduler tick + lifecycle', () => {
  let h: Harness;
  afterEach(async () => {
    if (h?.db) await h.db.close();
  });

  it('fires a due schedule via tick and skips missed fires (now-based)', async () => {
    h = await makeHarness([
      VALIDATE_OK,
      {
        match: 'SELECT_TICK',
        trinoId: 'qtick',
        pages: [{ columns: [{ name: 'n', type: 'bigint' }], data: [[1]] }],
      },
    ]);
    const s = await h.schedules.create('alice', {
      name: 'tick',
      statement: 'SELECT_TICK',
      cron: '* * * * *',
      datasourceId: DEFAULT_DATASOURCE_ID,

      principalSnapshot: { user: 'alice' },
    });
    // Start (seeds nextFire from now). enabled stays false so no real timer runs;
    // we drive tick() manually.
    await h.scheduler.start();
    // First tick at the seed time: not yet due.
    await h.scheduler.tick();
    expect(await h.runs.list(s.id, 10)).toHaveLength(0);
    // Advance the clock past the next minute and tick again: fires once.
    h.setNow(h.now() + 61_000);
    await h.scheduler.tick();
    await h.scheduler.whenIdle();
    const runs = await h.runs.list(s.id, 10);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('success');
  });

  it('does not fire cron while another job kind holds the shared slot', async () => {
    h = await makeHarness(
      [
        VALIDATE_OK,
        {
          match: 'SELECT_TICK_BLOCKED',
          pages: [{ columns: [{ name: 'n', type: 'bigint' }], data: [[1]] }],
        },
      ],
      { maxConcurrent: 1 },
    );
    const schedule = await h.schedules.create('alice', {
      name: 'tick blocked',
      statement: 'SELECT 1 /* SELECT_TICK_BLOCKED */',
      cron: '* * * * *',
      datasourceId: DEFAULT_DATASOURCE_ID,

      principalSnapshot: { user: 'alice' },
    });
    await h.scheduler.tick();
    const blocker = h.admission.tryAcquire('workflow', 'workflow-holder');

    h.setNow(h.now() + 61_000);
    await h.scheduler.tick();
    await h.scheduler.whenIdle();
    expect(await h.runs.list(schedule.id, 10)).toEqual([]);

    blocker.release();
  });

  it('aborts orphaned running rows on start (crash recovery)', async () => {
    h = await makeHarness([VALIDATE_OK]);
    const s = await h.schedules.create('alice', {
      name: 'orphan',
      statement: 'SELECT 1',
      cron: '* * * * *',
      datasourceId: DEFAULT_DATASOURCE_ID,

      principalSnapshot: { user: 'alice' },
    });
    // Simulate a run left `running` by a crashed process.
    const orphanId = await h.runs.start({
      scheduleId: s.id,
      owner: 'alice',
      scheduledFor: '2026-01-01T00:00:00.000Z',
      startedAt: '2026-01-01T00:00:00.000Z',
    });
    await h.scheduler.start();
    const runs = await h.runs.list(s.id, 10);
    const orphan = runs.find((r) => r.id === orphanId);
    expect(orphan?.status).toBe('aborted');
    expect(orphan?.finishedAt).not.toBeNull();
  });
});

describe('Scheduler disabled', () => {
  it('does not start the tick loop but still recovers orphans', async () => {
    vi.useFakeTimers();
    try {
      const h = await makeHarness([VALIDATE_OK], { enabled: false });
      const s = await h.schedules.create('alice', {
        name: 'x',
        statement: 'SELECT 1',
        cron: '* * * * *',
        datasourceId: DEFAULT_DATASOURCE_ID,

        principalSnapshot: { user: 'alice' },
      });
      const orphanId = await h.runs.start({
        scheduleId: s.id,
        owner: 'alice',
        scheduledFor: '2026-01-01T00:00:00.000Z',
        startedAt: '2026-01-01T00:00:00.000Z',
      });
      await h.scheduler.start();
      // No timer was scheduled; advancing fake time fires nothing.
      vi.advanceTimersByTime(60_000);
      const runs = await h.runs.list(s.id, 10);
      expect(runs.find((r) => r.id === orphanId)?.status).toBe('aborted');
      await h.db.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
