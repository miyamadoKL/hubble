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
    ttlMs: 60_000,
    defaultOverflowMode: 'truncate',
    sweepIntervalMs: 0,
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
    const gate = deferred();
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
    const gate = deferred();
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
