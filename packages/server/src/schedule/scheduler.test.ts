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
import { Scheduler, type SchedulerConfig } from './scheduler';
import { AuditLogger, AuditRepository } from '../audit';

const DEFAULT_GUARD_CONFIG = {
  mode: 'warn' as const,
  maxScanBytes: 0,
  maxScanRows: 100,
  onUnknown: 'warn' as const,
  estimateTimeoutMs: 3000,
  cacheTtlSeconds: 0,
  bytesPerSecond: 0,
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
  schedules: ScheduleRepository;
  runs: ScheduleRunRepository;
  scheduler: Scheduler;
  audit: AuditLogger;
  sleeps: number[];
  now: () => number;
  setNow: (ms: number) => void;
}

async function makeHarness(
  scenarios: FakeScenario[],
  configOverrides: Partial<SchedulerConfig> = {},
  /** Invoked on each retry backoff sleep (e.g. to swap scenarios mid-run). */
  onSleep?: (callIndex: number, ms: number) => void,
  getRbac?: () => LoadedRbac,
): Promise<Harness> {
  const db = await openMemoryDatabase();
  const fake = new FakeTrino(scenarios);
  const { engines, defaultDatasourceId } = makeEnginesMap(fake);
  const schedules = new ScheduleRepository(db);
  const runs = new ScheduleRunRepository(db, 50);
  const audit = new AuditLogger(new AuditRepository(db));
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
  const scheduler = new Scheduler({
    schedules,
    runs,
    engines,
    defaultDatasourceId,
    estimate,
    getRbac: getRbac ?? (() => loadRbac({})),
    guardConfig: {
      ...DEFAULT_GUARD_CONFIG,
      mode: configOverrides.guardMode ?? DEFAULT_GUARD_CONFIG.mode,
    },
    audit,
    config,
    now,
    sleep: (ms) => {
      onSleep?.(sleeps.length, ms);
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  return {
    db,
    fake,
    schedules,
    runs,
    scheduler,
    audit,
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
      statement: 'SELECT_FLAKY',
      cron: '* * * * *',
      retry: { maxAttempts: 3, backoffSeconds: 30, backoffMultiplier: 2 },
      datasourceId: DEFAULT_DATASOURCE_ID,
    });
    await h.scheduler.runManual(s);
    await h.scheduler.whenIdle();

    const runs = await h.runs.list(s.id, 10);
    expect(runs[0]!.status).toBe('success');
    expect(runs[0]!.attempt).toBe(2); // failed once, succeeded on retry
    expect(runs[0]!.rowCount).toBe(1);
    expect(runs[0]!.trinoQueryId).toMatch(/^qflakyok_/);
    expect(h.sleeps).toEqual([30_000]); // one backoff before the single retry
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
      statement: 'SELECT_DOWN',
      cron: '* * * * *',
      retry: { maxAttempts: 3, backoffSeconds: 30, backoffMultiplier: 2 },
      datasourceId: DEFAULT_DATASOURCE_ID,
    });
    await h.scheduler.runManual(s);
    await h.scheduler.whenIdle();

    const runs = await h.runs.list(s.id, 10);
    expect(runs[0]!.status).toBe('failed');
    expect(runs[0]!.errorType).toBe('INTERNAL_ERROR');
    expect(runs[0]!.attempt).toBe(3);
    // Two backoff waits between three attempts: 30s and 60s.
    expect(h.sleeps).toEqual([30_000, 60_000]);
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
    });
    await h.scheduler.runManual(s);
    // Second manual run must be rejected while the first is in flight.
    await expect(h.scheduler.runManual(s)).rejects.toThrow(/in progress/);
    expect(h.scheduler.activeRuns).toBe(1);
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

  it('aborts orphaned running rows on start (crash recovery)', async () => {
    h = await makeHarness([VALIDATE_OK]);
    const s = await h.schedules.create('alice', {
      name: 'orphan',
      statement: 'SELECT 1',
      cron: '* * * * *',
      datasourceId: DEFAULT_DATASOURCE_ID,
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
