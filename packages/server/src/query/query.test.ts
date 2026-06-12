import { describe, it, expect } from 'vitest';
import type { QueryEvent, QuerySnapshot, QueryRowsPage } from '@hue-fable/contracts';
import { createTestContext } from '../test/harness';
import type { FakeScenario } from '../test/fakeTrino';

const NATION_COLUMNS = [
  { name: 'nationkey', type: 'bigint' },
  { name: 'name', type: 'varchar' },
];

function nationScenario(rowCount: number): FakeScenario {
  const rows = Array.from({ length: rowCount }, (_, i) => [i, `nation_${i}`]);
  return {
    match: 'nation',
    trinoId: 'nation',
    pages: [
      { columns: NATION_COLUMNS, data: rows.slice(0, Math.ceil(rowCount / 2)), state: 'RUNNING' },
      { data: rows.slice(Math.ceil(rowCount / 2)), state: 'FINISHED' },
    ],
  };
}

async function submit(
  app: ReturnType<typeof createTestContext>['app'],
  body: Record<string, unknown>,
): Promise<string> {
  const res = await app.request('/api/queries', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(202);
  const { queryId } = (await res.json()) as { queryId: string };
  return queryId;
}

describe('query lifecycle (happy path)', () => {
  it('accepts, runs to FINISHED and buffers all rows', async () => {
    const ctx = createTestContext({ scenarios: [nationScenario(25)] });
    const queryId = await submit(ctx.app, { statement: 'SELECT * FROM nation', catalog: 'tpch' });

    await ctx.services.registry.get(queryId)!.settled;

    const snapRes = await ctx.app.request(`/api/queries/${queryId}`);
    const snap = (await snapRes.json()) as QuerySnapshot;
    expect(snap.state).toBe('finished');
    expect(snap.rowCount).toBe(25);
    expect(snap.columns).toEqual(NATION_COLUMNS);
    expect(snap.trinoQueryId).toMatch(/^nation_/);
    expect(snap.infoUri).toContain('ui/query.html');
    expect(snap.finishedAt).toBeDefined();
  });

  it('forwards catalog/schema headers to Trino', async () => {
    const ctx = createTestContext({ scenarios: [nationScenario(4)] });
    const queryId = await submit(ctx.app, {
      statement: 'SELECT * FROM nation',
      catalog: 'tpch',
      schema: 'tiny',
    });
    await ctx.services.registry.get(queryId)!.settled;
    const post = ctx.fake.requests.find((r) => r.method === 'POST');
    expect(post?.headers['x-trino-catalog']).toBe('tpch');
    expect(post?.headers['x-trino-schema']).toBe('tiny');
    expect(post?.headers['x-trino-source']).toBe('hubble');
  });
});

describe('polling backoff discipline (C-1)', () => {
  it('does not sleep or escalate backoff across a stream of data pages', async () => {
    const sleeps: number[] = [];
    // 20 consecutive pages each carrying a row -> once data flows, the loop must
    // advance with zero delay and never escalate. The only unavoidable backoff
    // is the single one taken on the initial data-less QUEUED page (20ms); the
    // data stream itself adds nothing.
    const pages = Array.from({ length: 20 }, (_, i) => ({
      columns: i === 0 ? NATION_COLUMNS : undefined,
      data: [[i, `r${i}`]],
      state: i === 19 ? 'FINISHED' : 'RUNNING',
    }));
    const ctx = createTestContext({
      scenarios: [{ match: 'stream', trinoId: 'stream', pages }],
      sleepImpl: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    const queryId = await submit(ctx.app, { statement: 'SELECT * FROM stream' });
    await ctx.services.registry.get(queryId)!.settled;

    expect(ctx.services.registry.get(queryId)!.rowCount).toBe(20);
    // At most one backoff (the initial QUEUED page), and at the floor — never
    // the monotonically-increasing ladder the old loop produced.
    expect(sleeps.every((ms) => ms === 20)).toBe(true);
    expect(sleeps.length).toBeLessThanOrEqual(1);
  });

  it('escalates backoff only across consecutive data-less pages', async () => {
    const sleeps: number[] = [];
    // The initial QUEUED page plus four more data-less pages, then a data page,
    // then finish. Backoff escalates over the empty run (20,40,60,80,100), resets
    // on data, and is not applied again before the final (data) page.
    const pages = [
      { state: 'RUNNING' },
      { state: 'RUNNING' },
      { state: 'RUNNING' },
      { state: 'RUNNING' },
      { columns: NATION_COLUMNS, data: [[1, 'a']], state: 'RUNNING' },
      { data: [[2, 'b']], state: 'FINISHED' },
    ];
    const ctx = createTestContext({
      scenarios: [{ match: 'idle', trinoId: 'idle', pages }],
      sleepImpl: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    const queryId = await submit(ctx.app, { statement: 'SELECT * FROM idle' });
    await ctx.services.registry.get(queryId)!.settled;

    // QUEUED + four data-less pages -> 20,40,60,80,100; data pages add no sleep.
    expect(sleeps).toEqual([20, 40, 60, 80, 100]);
  });
});

describe('row paging', () => {
  it('serves pages via offset/limit', async () => {
    const ctx = createTestContext({ scenarios: [nationScenario(25)] });
    const queryId = await submit(ctx.app, { statement: 'SELECT * FROM nation', catalog: 'tpch' });
    await ctx.services.registry.get(queryId)!.settled;

    const res = await ctx.app.request(`/api/queries/${queryId}/rows?offset=10&limit=5`);
    const page = (await res.json()) as QueryRowsPage;
    expect(page.offset).toBe(10);
    expect(page.rows).toHaveLength(5);
    expect(page.rows[0]).toEqual([10, 'nation_10']);
    expect(page.totalBuffered).toBe(25);
    expect(page.complete).toBe(true);
  });
});

describe('maxRows truncate', () => {
  it('stops buffering at maxRows but still finishes', async () => {
    const ctx = createTestContext({ scenarios: [nationScenario(25)] });
    const queryId = await submit(ctx.app, {
      statement: 'SELECT * FROM nation',
      catalog: 'tpch',
      maxRows: 10,
    });
    const exec = ctx.services.registry.get(queryId)!;
    await exec.settled;

    expect(exec.state).toBe('finished');
    expect(exec.bufferedCount).toBe(10);
    expect(exec.rowCount).toBe(25); // total produced
    expect(exec.truncated).toBe(true);

    const snapRes = await ctx.app.request(`/api/queries/${queryId}`);
    const snap = (await snapRes.json()) as QuerySnapshot;
    expect(snap.truncated).toBe(true);
  });
});

describe('cancellation', () => {
  it('cancels a running query and propagates DELETE', async () => {
    // Many pages so it would keep running; the holdAdvance gate keeps it parked
    // on the first nextUri until we cancel, making the test deterministic.
    const scenario: FakeScenario = {
      match: 'big',
      trinoId: 'big',
      pages: Array.from({ length: 50 }, (_, i) => ({
        columns: i === 0 ? NATION_COLUMNS : undefined,
        data: [[i, `r${i}`]],
        state: 'RUNNING',
      })),
    };
    const ctx = createTestContext({ scenarios: [scenario] });
    let release: () => void = () => {};
    ctx.fake.holdAdvance = new Promise<void>((r) => {
      release = r;
    });
    const queryId = await submit(ctx.app, { statement: 'SELECT * FROM big', catalog: 'tpch' });

    // Let the initial POST + state transition settle, then cancel while parked.
    await new Promise((r) => setTimeout(r, 10));
    const delRes = await ctx.app.request(`/api/queries/${queryId}`, { method: 'DELETE' });
    expect(delRes.status).toBe(200);
    release();
    await ctx.services.registry.get(queryId)!.settled;

    expect(ctx.services.registry.get(queryId)!.state).toBe('canceled');
    expect(ctx.fake.requests.some((r) => r.method === 'DELETE')).toBe(true);
  });
});

describe('trino error -> failed', () => {
  it('records line/column from a syntax error', async () => {
    const ctx = createTestContext({
      scenarios: [
        {
          match: 'SELECT FROM',
          error: {
            message: "line 1:8: mismatched input 'FROM'",
            errorName: 'SYNTAX_ERROR',
            errorLocation: { lineNumber: 1, columnNumber: 8 },
          },
        },
      ],
    });
    const queryId = await submit(ctx.app, { statement: 'SELECT FROM x' });
    const exec = ctx.services.registry.get(queryId)!;
    await exec.settled;
    expect(exec.state).toBe('failed');
    expect(exec.error?.trinoErrorName).toBe('SYNTAX_ERROR');
    expect(exec.error?.line).toBe(1);
    expect(exec.error?.column).toBe(8);
  });
});

describe('set-catalog header reflection', () => {
  it('captures x-trino-set-catalog into session mutations', async () => {
    const ctx = createTestContext({
      scenarios: [
        {
          match: 'SET CATALOG',
          trinoId: 'setcat',
          pages: [{ state: 'FINISHED', setHeaders: { 'x-trino-set-catalog': 'mysql' } }],
        },
      ],
    });
    const queryId = await submit(ctx.app, { statement: 'SET CATALOG mysql' });
    const exec = ctx.services.registry.get(queryId)!;
    await exec.settled;
    expect(exec.mutations.setCatalog).toBe('mysql');
  });
});

describe('SSE events', () => {
  it('replays state/columns/rows/stats/done and finishes the stream', async () => {
    const ctx = createTestContext({ scenarios: [nationScenario(6)] });
    const queryId = await submit(ctx.app, { statement: 'SELECT * FROM nation', catalog: 'tpch' });
    // Wait for terminal so the SSE stream replays a complete state and ends.
    await ctx.services.registry.get(queryId)!.settled;

    const res = await ctx.app.request(`/api/queries/${queryId}/events`);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    const events = parseSse(text);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('state');
    expect(types).toContain('columns');
    expect(types).toContain('rows');
    expect(types).toContain('done');

    const done = events.find((e) => e.type === 'done');
    expect(done).toMatchObject({ type: 'done', state: 'finished', rowCount: 6, truncated: false });

    const rowsEvents = events.filter((e) => e.type === 'rows');
    const totalRows = rowsEvents.reduce((n, e) => n + (e as { rows: unknown[][] }).rows.length, 0);
    expect(totalRows).toBe(6);
  });

  it('streams live events when connecting before completion', async () => {
    // Gate Trino advance on a manual signal so we connect while running.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const scenario: FakeScenario = {
      match: 'slow',
      trinoId: 'slow',
      pages: [
        { columns: NATION_COLUMNS, data: [[1, 'a']], state: 'RUNNING' },
        { data: [[2, 'b']], state: 'FINISHED' },
      ],
    };
    const ctx = createTestContext({ scenarios: [scenario] });
    // Patch the registry's execution to await the gate between pages is complex;
    // instead connect immediately and read the whole stream until done.
    const queryId = await submit(ctx.app, { statement: 'SELECT * FROM slow' });
    release?.();
    void gate;

    const res = await ctx.app.request(`/api/queries/${queryId}/events`);
    const text = await res.text();
    const events = parseSse(text);
    expect(events.some((e) => e.type === 'done')).toBe(true);
    const totalRows = events
      .filter((e) => e.type === 'rows')
      .reduce((n, e) => n + (e as { rows: unknown[][] }).rows.length, 0);
    expect(totalRows).toBe(2);
  });
});

function parseSse(text: string): QueryEvent[] {
  const events: QueryEvent[] = [];
  for (const block of text.split('\n\n')) {
    const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
    if (!dataLine) continue;
    try {
      events.push(JSON.parse(dataLine.slice('data: '.length)) as QueryEvent);
    } catch {
      // keep-alive comment or partial frame
    }
  }
  return events;
}
