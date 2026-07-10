/**
 * LeasedEngine の参照カウントと drain を検証する。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueryEngine } from './types';
import { LeasedEngine } from './leasedEngine';
import { createEngineForDatasource } from './factory';
import { FakeTrino } from '../test/fakeTrino';
import { makeTrinoDatasource, TEST_TRINO_CONFIG } from '../test/testEngine';

function innerEngine(close = vi.fn(async () => {})): QueryEngine {
  return {
    datasourceId: 'test-engine',
    kind: 'trino',
    capabilities: {
      query: true,
      metadata: true,
      costEstimate: true,
      impersonation: true,
      sessionProperties: true,
    },
    executionClient: vi.fn(),
    downloadClient: vi.fn(),
    estimate: vi.fn(),
    validate: vi.fn(),
    listCatalogs: vi.fn(),
    listSchemas: vi.fn(),
    listTables: vi.fn(),
    describeTable: vi.fn(),
    sampleTable: vi.fn(),
    close,
    isClosed: () => false,
  } as unknown as QueryEngine;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('LeasedEngine', () => {
  it('wraps every engine created by the datasource factory', async () => {
    const fake = new FakeTrino();
    const engine = createEngineForDatasource(makeTrinoDatasource(), {
      trinoConfig: TEST_TRINO_CONFIG,
      fetchImpl: fake.fetch,
    });

    expect(engine).toBeInstanceOf(LeasedEngine);
    expect(typeof engine.lease).toBe('function');
    await engine.close();
  });

  it('waits for an active lease before closing the inner engine', async () => {
    const closeInner = vi.fn(async () => {});
    const engine = new LeasedEngine(innerEngine(closeInner));
    const release = engine.lease();

    const closing = engine.close();
    await Promise.resolve();
    expect(closeInner).not.toHaveBeenCalled();

    release();
    await closing;
    expect(closeInner).toHaveBeenCalledOnce();
  });

  it('waits until every lease is released', async () => {
    const closeInner = vi.fn(async () => {});
    const engine = new LeasedEngine(innerEngine(closeInner));
    const releaseFirst = engine.lease();
    const releaseSecond = engine.lease();
    const closing = engine.close();

    releaseFirst();
    await Promise.resolve();
    expect(closeInner).not.toHaveBeenCalled();

    releaseSecond();
    await closing;
    expect(closeInner).toHaveBeenCalledOnce();
  });

  it('forces close with a warning after the drain timeout', async () => {
    vi.useFakeTimers();
    const closeInner = vi.fn(async () => {});
    const logWarn = vi.fn();
    const engine = new LeasedEngine(innerEngine(closeInner), {
      drainTimeoutMs: 100,
      logWarn,
    });
    engine.lease();

    const closing = engine.close();
    await vi.advanceTimersByTimeAsync(100);
    await closing;

    expect(closeInner).toHaveBeenCalledOnce();
    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining('drain timed out'));
  });

  it('makes each release function idempotent', async () => {
    const closeInner = vi.fn(async () => {});
    const engine = new LeasedEngine(innerEngine(closeInner));
    const releaseFirst = engine.lease();
    const releaseSecond = engine.lease();

    releaseFirst();
    releaseFirst();
    const closing = engine.close();
    await Promise.resolve();
    expect(closeInner).not.toHaveBeenCalled();

    releaseSecond();
    await closing;
    expect(closeInner).toHaveBeenCalledOnce();
  });

  it('rejects new leases after close starts and closes only once', async () => {
    const closeInner = vi.fn(async () => {});
    const engine = new LeasedEngine(innerEngine(closeInner));

    const firstClose = engine.close();
    const secondClose = engine.close();
    expect(() => engine.lease()).toThrow('is closing');
    await Promise.all([firstClose, secondClose]);

    expect(closeInner).toHaveBeenCalledOnce();
    expect(engine.isClosed()).toBe(true);
  });
});
