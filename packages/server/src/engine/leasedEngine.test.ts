/**
 * LeasedEngine の参照カウントと drain を検証する。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueryEngine, StatementClient } from './types';
import { LeasedEngine } from './leasedEngine';
import { driveStatementPages } from './statementDriver';
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

function statementClient(overrides: Partial<StatementClient> = {}): StatementClient {
  return {
    start: vi.fn(async () => ({ id: 'q', nextUri: 'next', stats: { state: 'RUNNING' } })),
    advance: vi.fn(async () => ({ id: 'q', stats: { state: 'FINISHED' } })),
    cancel: vi.fn(async () => {}),
    waitBackoff: vi.fn(async () => {}),
    ...overrides,
  };
}

const statementArgs = ['SELECT 1', {}, { setSession: {}, clearSession: [] }] as Parameters<
  StatementClient['start']
>;

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

  it('holds an automatic lease until a promise operation succeeds', async () => {
    const closeInner = vi.fn(async () => {});
    const pending = Promise.withResolvers<{ name: string }[]>();
    const inner = innerEngine(closeInner);
    inner.listCatalogs = vi.fn(() => pending.promise);
    const engine = new LeasedEngine(inner);

    const catalogs = engine.listCatalogs({ principal: 'alice' });
    const closing = engine.close();
    await Promise.resolve();
    expect(closeInner).not.toHaveBeenCalled();

    pending.resolve([{ name: 'catalog' }]);
    await expect(catalogs).resolves.toEqual([{ name: 'catalog' }]);
    await closing;
    expect(closeInner).toHaveBeenCalledOnce();
  });

  it('releases an automatic promise lease after rejection', async () => {
    const closeInner = vi.fn(async () => {});
    const pending = Promise.withResolvers<{ name: string }[]>();
    const inner = innerEngine(closeInner);
    inner.listCatalogs = vi.fn(() => pending.promise);
    const engine = new LeasedEngine(inner);

    const catalogs = engine.listCatalogs({ principal: 'alice' });
    const closing = engine.close();
    pending.reject(new Error('metadata failed'));

    await expect(catalogs).rejects.toThrow('metadata failed');
    await closing;
    expect(closeInner).toHaveBeenCalledOnce();
  });

  it('holds a client lease through pages and releases it on success', async () => {
    const closeInner = vi.fn(async () => {});
    const client = statementClient();
    const inner = innerEngine(closeInner);
    inner.executionClient = vi.fn(() => client);
    const engine = new LeasedEngine(inner);
    const scoped = engine.executionClient({ source: 'user' });

    await expect(scoped.start(...statementArgs)).resolves.toMatchObject({ nextUri: 'next' });
    const closing = engine.close();
    await Promise.resolve();
    expect(closeInner).not.toHaveBeenCalled();

    await expect(
      scoped.advance('next', {}, { setSession: {}, clearSession: [] }),
    ).resolves.not.toHaveProperty('nextUri');
    await closing;
    expect(closeInner).toHaveBeenCalledOnce();
  });

  it('releases a client lease exactly once after failure or cancellation', async () => {
    const failedClose = vi.fn(async () => {});
    const failedInner = innerEngine(failedClose);
    failedInner.executionClient = vi.fn(() =>
      statementClient({
        start: vi.fn(async () => Promise.reject(new DOMException('aborted', 'AbortError'))),
      }),
    );
    const failedEngine = new LeasedEngine(failedInner);
    const failedClient = failedEngine.executionClient({ source: 'user' });

    await expect(failedClient.start(...statementArgs)).rejects.toThrow('aborted');
    await failedEngine.close();
    expect(failedClose).toHaveBeenCalledOnce();

    const canceledClose = vi.fn(async () => {});
    const cancel = vi
      .fn<StatementClient['cancel']>()
      .mockRejectedValueOnce(new Error('cancel failed'))
      .mockResolvedValue(undefined);
    const canceledInner = innerEngine(canceledClose);
    canceledInner.downloadClient = vi.fn(() => statementClient({ cancel }));
    const canceledEngine = new LeasedEngine(canceledInner);
    const firstClient = canceledEngine.downloadClient();
    const secondClient = canceledEngine.downloadClient();
    await firstClient.start(...statementArgs);
    await secondClient.start(...statementArgs);

    await expect(firstClient.cancel('next', {})).rejects.toThrow('cancel failed');
    await expect(firstClient.cancel('next', {})).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(2);
    const closing = canceledEngine.close();
    await Promise.resolve();
    expect(canceledClose).not.toHaveBeenCalled();

    await expect(secondClient.cancel('next', {})).resolves.toBeUndefined();
    await closing;
    expect(cancel).toHaveBeenCalledTimes(3);
    expect(canceledClose).toHaveBeenCalledOnce();
  });

  it('bounds a never-resolving cancel after an advance failure', async () => {
    vi.useFakeTimers();
    const closeInner = vi.fn(async () => {});
    const advanceError = new Error('advance failed');
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const inner = innerEngine(closeInner);
    inner.executionClient = vi.fn(() =>
      statementClient({
        advance: vi.fn(async () => Promise.reject(advanceError)),
        cancel,
      }),
    );
    const engine = new LeasedEngine(inner, {
      cancelTimeoutMs: 100,
      drainTimeoutMs: 1_000,
    });
    const client = engine.executionClient({ source: 'user' });

    const running = driveStatementPages({
      client,
      statement: 'SELECT 1',
      ctx: { user: 'alice' },
      onPage: () => undefined,
    }).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce();
    const closing = engine.close();
    await vi.advanceTimersByTimeAsync(99);
    expect(closeInner).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await expect(running).resolves.toEqual({ ok: false, error: advanceError });
    await closing;
    expect(cancel).toHaveBeenCalledWith('next', { user: 'alice' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(closeInner).toHaveBeenCalledOnce();
  });

  it('keeps an explicit lease independent from the client lease', async () => {
    const closeInner = vi.fn(async () => {});
    const inner = innerEngine(closeInner);
    inner.executionClient = vi.fn(() => statementClient());
    const engine = new LeasedEngine(inner);
    const releaseExplicit = engine.lease();
    const client = engine.executionClient({ source: 'user' });

    await client.start(...statementArgs);
    await client.advance('next', {}, { setSession: {}, clearSession: [] });
    const closing = engine.close();
    await Promise.resolve();
    expect(closeInner).not.toHaveBeenCalled();

    releaseExplicit();
    releaseExplicit();
    await closing;
    expect(closeInner).toHaveBeenCalledOnce();
  });

  it('rejects client operations that were not started before close', async () => {
    const closeInner = vi.fn(async () => {});
    const inner = innerEngine(closeInner);
    inner.executionClient = vi.fn(() => statementClient());
    const engine = new LeasedEngine(inner);
    const client = engine.executionClient({ source: 'user' });

    await engine.close();
    expect(closeInner).toHaveBeenCalledOnce();
    expect(() => engine.downloadClient()).toThrow('is closing');
    await expect(client.waitBackoff(0)).rejects.toThrow('is closing');
    await expect(client.start(...statementArgs)).rejects.toThrow('is closing');
  });

  it('does not reserve a lease for an unused IO explain client', async () => {
    const closeInner = vi.fn(async () => {});
    const inner = innerEngine(closeInner);
    inner.ioExplainExecution = vi.fn(() => ({ client: statementClient(), ctx: {} }));
    const engine = new LeasedEngine(inner);
    const execution = engine.ioExplainExecution({
      statement: 'SELECT 1',
      principal: 'alice',
    });

    await engine.close();
    expect(closeInner).toHaveBeenCalledOnce();
    await expect(execution?.client.start(...statementArgs)).rejects.toThrow('is closing');
  });
});
