import { describe, it, expect } from 'vitest';
import type { ApiError, EstimateResult } from '@hubble/contracts';
import { estimateResultSchema } from '@hubble/contracts';
import { createTestContext } from '../test/harness';
import type { FakeScenario } from '../test/fakeTrino';

// EXPLAIN IO returns one row, one varchar column holding the JSON plan string.
function ioPlanCell(opts: {
  catalog: string;
  schema: string;
  table: string;
  rows: number | 'NaN';
  bytes: number | 'NaN';
}): string {
  return JSON.stringify({
    inputTableColumnInfos: [
      {
        table: { catalog: opts.catalog, schemaTable: { schema: opts.schema, table: opts.table } },
        constraint: { none: false, columnConstraints: [] },
        estimate: { outputRowCount: opts.rows, outputSizeInBytes: opts.bytes },
      },
    ],
    estimate: { outputRowCount: opts.rows, outputSizeInBytes: opts.bytes },
  });
}

function explainScenario(match: string, cell: string, trinoId = 'explain'): FakeScenario {
  return {
    match,
    trinoId,
    pages: [
      {
        columns: [{ name: 'Query Plan', type: 'varchar' }],
        data: [[cell]],
        state: 'FINISHED',
      },
    ],
  };
}

const lineitemCell = ioPlanCell({
  catalog: 'tpch',
  schema: 'sf1',
  table: 'lineitem',
  rows: 6_001_215,
  bytes: 783_988_912,
});

const nationCell = ioPlanCell({
  catalog: 'tpch',
  schema: 'tiny',
  table: 'nation',
  rows: 25,
  bytes: 2734,
});

async function postEstimate(
  app: Awaited<ReturnType<typeof createTestContext>>['app'],
  body: Record<string, unknown>,
): Promise<{ status: number; json: unknown }> {
  const res = await app.request('/api/queries/estimate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

describe('POST /api/queries/estimate', () => {
  it('returns an estimated verdict that blocks in enforce mode', async () => {
    const ctx = await createTestContext({
      scenarios: [explainScenario('lineitem', lineitemCell)],
      configOverrides: {
        guard: {
          mode: 'enforce',
          maxScanBytes: 0,
          maxScanRows: 1_000_000,
          onUnknown: 'warn',
          estimateTimeoutMs: 3000,
          cacheTtlSeconds: 30,
          bytesPerSecond: 0,
        },
      },
    });
    const { status, json } = await postEstimate(ctx.app, {
      statement: 'SELECT * FROM lineitem',
      catalog: 'tpch',
      schema: 'sf1',
    });
    expect(status).toBe(200);
    const result = estimateResultSchema.parse(json) as EstimateResult;
    expect(result.status).toBe('estimated');
    expect(result.scanRows).toBe(6_001_215);
    expect(result.scanBytes).toBe(783_988_912);
    expect(result.verdict.decision).toBe('block');
  });

  it('allows a small table under the limit', async () => {
    const ctx = await createTestContext({
      scenarios: [explainScenario('nation', nationCell)],
      configOverrides: {
        guard: {
          mode: 'enforce',
          maxScanBytes: 0,
          maxScanRows: 1_000_000,
          onUnknown: 'warn',
          estimateTimeoutMs: 3000,
          cacheTtlSeconds: 30,
          bytesPerSecond: 0,
        },
      },
    });
    const { json } = await postEstimate(ctx.app, {
      statement: 'SELECT * FROM nation',
      catalog: 'tpch',
      schema: 'tiny',
    });
    const result = estimateResultSchema.parse(json) as EstimateResult;
    expect(result.status).toBe('estimated');
    expect(result.scanRows).toBe(25);
    expect(result.verdict.decision).toBe('allow');
  });

  it('computes estimatedSeconds when BYTES_PER_SECOND is set', async () => {
    const ctx = await createTestContext({
      scenarios: [explainScenario('lineitem', lineitemCell)],
      configOverrides: {
        guard: {
          mode: 'warn',
          maxScanBytes: 0,
          maxScanRows: 0,
          onUnknown: 'warn',
          estimateTimeoutMs: 3000,
          cacheTtlSeconds: 30,
          bytesPerSecond: 100_000_000,
        },
      },
    });
    const { json } = await postEstimate(ctx.app, {
      statement: 'SELECT * FROM lineitem',
      catalog: 'tpch',
      schema: 'sf1',
    });
    const result = estimateResultSchema.parse(json) as EstimateResult;
    expect(result.estimatedSeconds).toBeCloseTo(783988912 / 100_000_000, 5);
  });

  it('returns a disabled estimate without touching Trino when mode=off', async () => {
    const ctx = await createTestContext({
      scenarios: [explainScenario('lineitem', lineitemCell)],
      configOverrides: {
        guard: {
          mode: 'off',
          maxScanBytes: 0,
          maxScanRows: 0,
          onUnknown: 'warn',
          estimateTimeoutMs: 3000,
          cacheTtlSeconds: 30,
          bytesPerSecond: 0,
        },
      },
    });
    const { json } = await postEstimate(ctx.app, { statement: 'SELECT * FROM lineitem' });
    const result = estimateResultSchema.parse(json) as EstimateResult;
    expect(result.status).toBe('disabled');
    expect(result.verdict.decision).toBe('allow');
    // No POST to Trino should have happened.
    expect(ctx.fake.requests.some((r) => r.method === 'POST')).toBe(false);
  });

  it('treats a Trino USER_ERROR as unsupported (allow even under strict limits)', async () => {
    const ctx = await createTestContext({
      scenarios: [
        {
          match: 'does_not_exist',
          error: {
            message: "line 1:15: Table 'tpch.tiny.does_not_exist' does not exist",
            errorName: 'TABLE_NOT_FOUND',
            errorCode: 46,
            errorType: 'USER_ERROR',
          },
        },
      ],
      configOverrides: {
        guard: {
          mode: 'enforce',
          maxScanBytes: 0,
          maxScanRows: 1,
          onUnknown: 'block',
          estimateTimeoutMs: 3000,
          cacheTtlSeconds: 30,
          bytesPerSecond: 0,
        },
      },
    });
    const { json } = await postEstimate(ctx.app, {
      statement: 'SELECT * FROM does_not_exist',
    });
    const result = estimateResultSchema.parse(json) as EstimateResult;
    // A USER_ERROR would fail the same way on the real run — no resource risk.
    expect(result.status).toBe('unsupported');
    expect(result.verdict.decision).toBe('allow');
  });

  it('tags the guard EXPLAIN with the metadata source and impersonates the principal', async () => {
    const ctx = await createTestContext({
      scenarios: [explainScenario('nation', nationCell)],
      configOverrides: {
        guard: {
          mode: 'warn',
          maxScanBytes: 0,
          maxScanRows: 0,
          onUnknown: 'warn',
          estimateTimeoutMs: 3000,
          cacheTtlSeconds: 30,
          bytesPerSecond: 0,
        },
      },
    });
    await postEstimate(ctx.app, {
      statement: 'SELECT * FROM nation',
      catalog: 'tpch',
      schema: 'tiny',
    });
    const post = ctx.fake.requests.find((r) => r.method === 'POST');
    expect(post?.body).toContain('EXPLAIN (TYPE IO, FORMAT JSON)');
    expect(post?.headers['x-trino-source']).toBe('hubble-metadata');
    // none-mode principal is the technical user 'admin'.
    expect(post?.headers['x-trino-user']).toBe('admin');
    expect(post?.headers['x-trino-catalog']).toBe('tpch');
    expect(post?.headers['x-trino-schema']).toBe('tiny');
  });

  it('serves a cached estimate on the second call (no extra Trino round-trip)', async () => {
    const ctx = await createTestContext({
      scenarios: [explainScenario('nation', nationCell)],
      configOverrides: {
        guard: {
          mode: 'warn',
          maxScanBytes: 0,
          maxScanRows: 0,
          onUnknown: 'warn',
          estimateTimeoutMs: 3000,
          cacheTtlSeconds: 30,
          bytesPerSecond: 0,
        },
      },
    });
    await postEstimate(ctx.app, {
      statement: 'SELECT * FROM nation',
      catalog: 'tpch',
      schema: 'tiny',
    });
    const afterFirst = ctx.fake.requests.filter((r) => r.method === 'POST').length;
    await postEstimate(ctx.app, {
      statement: 'SELECT * FROM nation',
      catalog: 'tpch',
      schema: 'tiny',
    });
    const afterSecond = ctx.fake.requests.filter((r) => r.method === 'POST').length;
    expect(afterSecond).toBe(afterFirst);
  });
});

describe('GET /api/config exposes guard settings', () => {
  it('includes the guard block', async () => {
    const ctx = await createTestContext({
      configOverrides: {
        guard: {
          mode: 'enforce',
          maxScanBytes: 1024,
          maxScanRows: 1_000_000,
          onUnknown: 'block',
          estimateTimeoutMs: 3000,
          cacheTtlSeconds: 30,
          bytesPerSecond: 500_000_000,
        },
      },
    });
    const res = await ctx.app.request('/api/config');
    const cfg = (await res.json()) as {
      guard: {
        mode: string;
        maxScanBytes: number;
        maxScanRows: number;
        onUnknown: string;
        bytesPerSecond: number;
      };
    };
    expect(cfg.guard).toEqual({
      mode: 'enforce',
      maxScanBytes: 1024,
      maxScanRows: 1_000_000,
      onUnknown: 'block',
      bytesPerSecond: 500_000_000,
    });
  });
});

describe('run path enforce (QUERY_BLOCKED)', () => {
  it('blocks a run that exceeds the limit in enforce mode', async () => {
    const ctx = await createTestContext({
      scenarios: [
        explainScenario('lineitem', lineitemCell, 'explain'),
        // The actual run scenario (should never be reached when blocked).
        {
          match: 'SELECT * FROM lineitem',
          trinoId: 'run',
          pages: [{ columns: [{ name: 'x', type: 'bigint' }], data: [[1]], state: 'FINISHED' }],
        },
      ],
      configOverrides: {
        guard: {
          mode: 'enforce',
          maxScanBytes: 0,
          maxScanRows: 1_000_000,
          onUnknown: 'warn',
          estimateTimeoutMs: 3000,
          cacheTtlSeconds: 30,
          bytesPerSecond: 0,
        },
      },
    });
    const res = await ctx.app.request('/api/queries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ statement: 'SELECT * FROM lineitem', catalog: 'tpch', schema: 'sf1' }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as ApiError;
    expect(body.error.code).toBe('QUERY_BLOCKED');
    expect(body.error.message).toContain('6,001,215');
    const details = body.error.details as { estimate: EstimateResult; limits: unknown };
    expect(details.estimate.verdict.decision).toBe('block');
    expect(details.limits).toMatchObject({ maxScanRows: 1_000_000 });
  });

  it('does not intervene in warn mode (run proceeds)', async () => {
    const ctx = await createTestContext({
      scenarios: [
        explainScenario('lineitem', lineitemCell, 'explain'),
        {
          match: 'SELECT * FROM lineitem',
          trinoId: 'run',
          pages: [{ columns: [{ name: 'x', type: 'bigint' }], data: [[1]], state: 'FINISHED' }],
        },
      ],
      configOverrides: {
        guard: {
          mode: 'warn',
          maxScanBytes: 0,
          maxScanRows: 1_000_000,
          onUnknown: 'warn',
          estimateTimeoutMs: 3000,
          cacheTtlSeconds: 30,
          bytesPerSecond: 0,
        },
      },
    });
    const res = await ctx.app.request('/api/queries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ statement: 'SELECT * FROM lineitem', catalog: 'tpch', schema: 'sf1' }),
    });
    expect(res.status).toBe(202);
    // In warn mode the run path never estimates, so no EXPLAIN POST is issued.
    const explainPosts = ctx.fake.requests.filter(
      (r) => r.method === 'POST' && (r.body ?? '').includes('EXPLAIN'),
    );
    expect(explainPosts).toHaveLength(0);
  });
});
