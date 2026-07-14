import { describe, it, expect, vi } from 'vitest';
import { QueryRegistry } from './registry';
import { FakeTrino } from '../test/fakeTrino';
import type { FakeScenario } from '../test/fakeTrino';
import {
  DEFAULT_DATASOURCE_ID,
  makeEnginesMap,
  makeTrinoDatasource,
  makeTrinoEngine,
} from '../test/testEngine';
import { LeasedEngine } from '../engine/leasedEngine';
import type { QueryEngine } from '../engine/types';
import { applyDatasourceReloadSync, type DatasourceReloadPlan } from '../datasource/reload';

const fast: FakeScenario = {
  match: 'SELECT',
  pages: [{ columns: [{ name: 'n', type: 'bigint' }], data: [[1]], state: 'FINISHED' }],
};

function makeRegistry(
  fake: FakeTrino,
  overrides: Partial<{
    concurrency: number;
    maxQueued: number;
    maxQueuedPerPrincipal: number;
    maxTracked: number;
    ttlMs: number;
    now: () => number;
  }> = {},
): QueryRegistry {
  const { engines, defaultDatasourceId } = makeEnginesMap(fake);
  return new QueryRegistry({
    engines,
    defaultDatasourceId,
    defaultMaxRows: 1000,
    concurrency: overrides.concurrency ?? 5,
    maxQueued: overrides.maxQueued ?? 100,
    maxQueuedPerPrincipal: overrides.maxQueuedPerPrincipal ?? 20,
    maxTracked: overrides.maxTracked ?? 10_000,
    ttlMs: overrides.ttlMs ?? 60_000,
    defaultOverflowMode: 'truncate',
    sweepIntervalMs: 0,
    now: overrides.now,
  });
}

function makeRegistryForEngines(
  engines: Map<string, QueryEngine>,
  concurrency: number,
): QueryRegistry {
  return new QueryRegistry({
    engines,
    defaultDatasourceId: DEFAULT_DATASOURCE_ID,
    defaultMaxRows: 1000,
    concurrency,
    maxQueued: 100,
    maxQueuedPerPrincipal: 20,
    maxTracked: 10_000,
    ttlMs: 60_000,
    defaultOverflowMode: 'truncate',
    sweepIntervalMs: 0,
  });
}

function reloadOldEngine(
  engines: Map<string, QueryEngine>,
  oldEngine: QueryEngine,
  replacement: QueryEngine,
): void {
  const datasource = makeTrinoDatasource();
  const plan: DatasourceReloadPlan = {
    datasources: [datasource],
    defaultDatasourceId: DEFAULT_DATASOURCE_ID,
    enginesToSet: new Map([[DEFAULT_DATASOURCE_ID, replacement]]),
    idsToRemove: [],
    enginesToClose: [oldEngine],
    invalidateDatasourceIds: [DEFAULT_DATASOURCE_ID],
  };
  const datasources = [datasource];
  applyDatasourceReloadSync(
    {
      engines,
      datasources,
      setDefaultDatasourceId: () => {},
      invalidateDatasource: () => {},
    },
    plan,
  );
}

describe('QueryRegistry concurrency', () => {
  it('limits concurrent runs and drains the queue', async () => {
    const fake = new FakeTrino([fast]);
    const registry = makeRegistry(fake, { concurrency: 2 });
    const execs = Array.from({ length: 5 }, () =>
      registry.submit({ statement: 'SELECT 1', ctx: {} }),
    );
    await Promise.all(execs.map((e) => e.settled));
    for (const e of execs) expect(e.state).toBe('finished');
  });

  it('drains queued leases before reload closes the old engine', async () => {
    const fake = new FakeTrino([fast]);
    const gate = Promise.withResolvers<void>();
    fake.holdAdvance = gate.promise;
    const inner = makeTrinoEngine(fake);
    const closeInner = vi.spyOn(inner, 'close');
    const oldEngine = new LeasedEngine(inner);
    const engines = new Map<string, QueryEngine>([[DEFAULT_DATASOURCE_ID, oldEngine]]);
    const registry = new QueryRegistry({
      engines,
      defaultDatasourceId: DEFAULT_DATASOURCE_ID,
      defaultMaxRows: 1000,
      concurrency: 1,
      maxQueued: 100,
      maxQueuedPerPrincipal: 20,
      maxTracked: 10_000,
      ttlMs: 60_000,
      defaultOverflowMode: 'truncate',
      sweepIntervalMs: 0,
    });
    const first = registry.submit({ statement: 'SELECT first', ctx: {} });
    await vi.waitFor(() => expect(fake.activeCount).toBe(1));
    const second = registry.submit({ statement: 'SELECT second', ctx: {} });

    reloadOldEngine(engines, oldEngine, makeTrinoEngine(fake));
    await Promise.resolve();
    expect(closeInner).not.toHaveBeenCalled();

    gate.resolve();
    await Promise.all([first.settled, second.settled]);
    await vi.waitFor(() => expect(closeInner).toHaveBeenCalledOnce());
    expect(first.state).toBe('finished');
    expect(second.state).toBe('finished');
  });

  it('releases a queued lease after cancellation before closing the old engine', async () => {
    const fake = new FakeTrino([fast]);
    const gate = Promise.withResolvers<void>();
    fake.holdAdvance = gate.promise;
    const inner = makeTrinoEngine(fake);
    const closeInner = vi.spyOn(inner, 'close');
    const oldEngine = new LeasedEngine(inner);
    const engines = new Map<string, QueryEngine>([[DEFAULT_DATASOURCE_ID, oldEngine]]);
    const registry = makeRegistryForEngines(engines, 1);
    const first = registry.submit({ statement: 'SELECT first', ctx: {} });
    await vi.waitFor(() => expect(fake.activeCount).toBe(1));
    const second = registry.submit({ statement: 'SELECT second', ctx: {} });

    reloadOldEngine(engines, oldEngine, makeTrinoEngine(fake));
    await second.requestCancel();
    await Promise.resolve();
    expect(closeInner).not.toHaveBeenCalled();

    gate.resolve();
    await Promise.all([first.settled, second.settled]);
    await vi.waitFor(() => expect(closeInner).toHaveBeenCalledOnce());
    expect(second.state).toBe('canceled');
  });

  it('bounds the global and per-principal wait queues', async () => {
    const fake = new FakeTrino([fast]);
    const gate = Promise.withResolvers<void>();
    fake.holdAdvance = gate.promise;
    const registry = makeRegistry(fake, {
      concurrency: 1,
      maxQueued: 2,
      maxQueuedPerPrincipal: 1,
    });
    const first = registry.submit({ statement: 'SELECT first', ctx: { user: 'alice' } });
    await vi.waitFor(() => expect(fake.activeCount).toBe(1));
    const second = registry.submit({ statement: 'SELECT second', ctx: { user: 'alice' } });

    expect(() =>
      registry.submit({ statement: 'SELECT third', ctx: { user: 'alice' } }),
    ).toThrowError(
      expect.objectContaining({
        status: 429,
        detail: expect.objectContaining({ code: 'QUERY_PRINCIPAL_QUEUE_FULL' }),
      }),
    );
    const third = registry.submit({ statement: 'SELECT third', ctx: { user: 'bob' } });
    expect(registry.queuedCount()).toBe(2);
    expect(() =>
      registry.submit({ statement: 'SELECT fourth', ctx: { user: 'charlie' } }),
    ).toThrowError(
      expect.objectContaining({
        status: 429,
        detail: expect.objectContaining({ code: 'QUERY_QUEUE_FULL' }),
      }),
    );

    gate.resolve();
    await Promise.all([first.settled, second.settled, third.settled]);
  });

  it('releases queue admission and skips result capture when a queued query is canceled', async () => {
    const fake = new FakeTrino([fast]);
    const gate = Promise.withResolvers<void>();
    fake.holdAdvance = gate.promise;
    const registry = makeRegistry(fake, {
      concurrency: 1,
      maxQueued: 1,
      maxQueuedPerPrincipal: 1,
    });
    const first = registry.submit({ statement: 'SELECT first', ctx: { user: 'alice' } });
    await vi.waitFor(() => expect(fake.activeCount).toBe(1));
    const makeResultObserver = vi.fn(() => undefined);
    const queued = registry.submit({
      statement: 'SELECT queued',
      ctx: { user: 'alice' },
      makeResultObserver,
    });
    expect(makeResultObserver).not.toHaveBeenCalled();

    await queued.requestCancel();
    await queued.settled;
    await vi.waitFor(() => expect(registry.queuedCount()).toBe(0));
    expect(makeResultObserver).not.toHaveBeenCalled();
    const replacement = registry.submit({
      statement: 'SELECT replacement',
      ctx: { user: 'alice' },
    });

    gate.resolve();
    await Promise.all([first.settled, replacement.settled]);
  });

  it('bounds tracked executions and rejects admission after stopAccepting', async () => {
    const fake = new FakeTrino([fast]);
    const gate = Promise.withResolvers<void>();
    fake.holdAdvance = gate.promise;
    const registry = makeRegistry(fake, { concurrency: 1, maxTracked: 1 });
    const first = registry.submit({ statement: 'SELECT first', ctx: { user: 'alice' } });
    await vi.waitFor(() => expect(fake.activeCount).toBe(1));

    expect(() =>
      registry.submit({ statement: 'SELECT second', ctx: { user: 'bob' } }),
    ).toThrowError(
      expect.objectContaining({
        status: 429,
        detail: expect.objectContaining({ code: 'QUERY_REGISTRY_FULL' }),
      }),
    );
    registry.stopAccepting();
    expect(() => registry.submit({ statement: 'SELECT third', ctx: { user: 'bob' } })).toThrowError(
      expect.objectContaining({
        status: 503,
        detail: expect.objectContaining({ code: 'QUERY_SHUTTING_DOWN' }),
      }),
    );

    gate.resolve();
    await first.settled;
  });
});

describe('QueryRegistry TTL sweep', () => {
  it('removes finished executions past the TTL', async () => {
    let now = 0;
    const fake = new FakeTrino([fast]);
    const registry = makeRegistry(fake, { ttlMs: 1000, now: () => now });
    const exec = registry.submit({ statement: 'SELECT 1', ctx: {} });
    await exec.settled;
    expect(registry.size()).toBe(1);

    now += 500;
    expect(registry.sweep()).toBe(0); // not yet expired
    expect(registry.size()).toBe(1);

    now += 1000;
    expect(registry.sweep()).toBe(1);
    expect(registry.size()).toBe(0);
  });
});

describe('QueryRegistry not found', () => {
  it('throws AppError(404) for an unknown id', () => {
    const fake = new FakeTrino([fast]);
    const registry = makeRegistry(fake);
    expect(() => registry.getOrThrow('nope')).toThrow(/not found/);
  });
});

describe('QueryRegistry shutdown', () => {
  it('is single-flight and returns at the deadline when cancellation does not settle', async () => {
    const fake = new FakeTrino([fast]);
    const gate = Promise.withResolvers<void>();
    fake.holdAdvance = gate.promise;
    const registry = makeRegistry(fake, { concurrency: 1 });
    const exec = registry.submit({ statement: 'SELECT blocked', ctx: { user: 'alice' } });
    await vi.waitFor(() => expect(fake.activeCount).toBe(1));
    const cancel = vi.spyOn(exec, 'requestCancel').mockImplementation(() => new Promise(() => {}));

    const first = registry.shutdown({ deadlineAt: Date.now() + 20 });
    const second = registry.shutdown({ deadlineAt: Date.now() + 1_000 });
    expect(first).toBe(second);
    await expect(first).resolves.toEqual({ timedOut: true });
    expect(cancel).toHaveBeenCalledOnce();

    cancel.mockRestore();
    gate.resolve();
    await exec.settled;
  });

  it('cancels queued and running executions and waits for both terminal states', async () => {
    const fake = new FakeTrino([fast]);
    const gate = Promise.withResolvers<void>();
    fake.holdAdvance = gate.promise;
    const registry = makeRegistry(fake, { concurrency: 1 });
    const running = registry.submit({ statement: 'SELECT running', ctx: { user: 'alice' } });
    await vi.waitFor(() => expect(fake.activeCount).toBe(1));
    const queued = registry.submit({ statement: 'SELECT queued', ctx: { user: 'bob' } });

    const shuttingDown = registry.shutdown({ deadlineAt: Date.now() + 1_000 });
    gate.resolve();
    await expect(shuttingDown).resolves.toEqual({ timedOut: false });
    expect(running.state).toBe('canceled');
    expect(queued.state).toBe('canceled');
    expect(registry.queuedCount()).toBe(0);
  });
});
