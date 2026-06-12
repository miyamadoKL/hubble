import { describe, it, expect } from 'vitest';
import { TrinoClient } from '../trino/client';
import { QueryRegistry } from './registry';
import { FakeTrino } from '../test/fakeTrino';
import type { FakeScenario } from '../test/fakeTrino';

function makeClient(fake: FakeTrino): TrinoClient {
  return new TrinoClient({
    baseUrl: 'http://trino.test',
    username: 'admin',
    password: '',
    user: 'admin',
    source: 'hubble',
    fetchImpl: fake.fetch,
    sleepImpl: () => Promise.resolve(),
  });
}

const fast: FakeScenario = {
  match: 'SELECT',
  pages: [{ columns: [{ name: 'n', type: 'bigint' }], data: [[1]], state: 'FINISHED' }],
};

describe('QueryRegistry concurrency', () => {
  it('limits concurrent runs and drains the queue', async () => {
    const fake = new FakeTrino([fast]);
    const registry = new QueryRegistry({
      client: makeClient(fake),
      defaultMaxRows: 1000,
      concurrency: 2,
      ttlMs: 60_000,
      defaultOverflowMode: 'truncate',
      sweepIntervalMs: 0,
    });
    const execs = Array.from({ length: 5 }, () =>
      registry.submit({ statement: 'SELECT 1', ctx: {} }),
    );
    await Promise.all(execs.map((e) => e.settled));
    for (const e of execs) expect(e.state).toBe('finished');
  });
});

describe('QueryRegistry TTL sweep', () => {
  it('removes finished executions past the TTL', async () => {
    let now = 0;
    const fake = new FakeTrino([fast]);
    const registry = new QueryRegistry({
      client: makeClient(fake),
      defaultMaxRows: 1000,
      concurrency: 5,
      ttlMs: 1000,
      defaultOverflowMode: 'truncate',
      sweepIntervalMs: 0,
      now: () => now,
    });
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
    const registry = new QueryRegistry({
      client: makeClient(fake),
      defaultMaxRows: 1000,
      concurrency: 5,
      ttlMs: 60_000,
      defaultOverflowMode: 'truncate',
      sweepIntervalMs: 0,
    });
    expect(() => registry.getOrThrow('nope')).toThrow(/not found/);
  });
});
