import { describe, it, expect } from 'vitest';
import { TrinoClient } from './client';
import { emptySessionMutations } from './types';
import { AppError } from '../errors';

function client(fetchImpl: typeof fetch): TrinoClient {
  return new TrinoClient({
    baseUrl: 'http://trino.test/',
    username: 'admin',
    password: '',
    user: 'admin',
    source: 'hubble',
    fetchImpl,
    sleepImpl: () => Promise.resolve(),
  });
}

describe('TrinoClient backoff', () => {
  it('starts at 20ms, +20ms per attempt, capped at 1000ms', () => {
    const c = client((() => Promise.resolve(new Response('{}'))) as typeof fetch);
    expect(c.backoffMs(0)).toBe(20);
    expect(c.backoffMs(1)).toBe(40);
    expect(c.backoffMs(10)).toBe(220);
    expect(c.backoffMs(100)).toBe(1000); // capped
  });
});

describe('TrinoClient headers', () => {
  it('sends Basic auth, X-Trino-User, source, catalog, schema, session', async () => {
    let captured: Headers | undefined;
    const fetchImpl = ((_url: string, init: RequestInit) => {
      captured = new Headers(init.headers);
      return Promise.resolve(
        new Response(JSON.stringify({ id: 'q1', stats: { state: 'FINISHED' } }), { status: 200 }),
      );
    }) as unknown as typeof fetch;

    await client(fetchImpl).start(
      'SELECT 1',
      {
        catalog: 'tpch',
        schema: 'tiny',
        source: 'custom-source',
        sessionProperties: { query_max_run_time: '10m' },
      },
      emptySessionMutations(),
    );

    expect(captured?.get('x-trino-user')).toBe('admin');
    expect(captured?.get('x-trino-source')).toBe('custom-source');
    expect(captured?.get('x-trino-catalog')).toBe('tpch');
    expect(captured?.get('x-trino-schema')).toBe('tiny');
    expect(captured?.get('x-trino-session')).toBe('query_max_run_time=10m');
    expect(captured?.get('authorization')).toMatch(/^Basic /);
  });

  it('defaults source when none provided', async () => {
    let captured: Headers | undefined;
    const fetchImpl = ((_url: string, init: RequestInit) => {
      captured = new Headers(init.headers);
      return Promise.resolve(
        new Response(JSON.stringify({ id: 'q1', stats: { state: 'FINISHED' } }), { status: 200 }),
      );
    }) as unknown as typeof fetch;
    await client(fetchImpl).start('SELECT 1', {}, emptySessionMutations());
    expect(captured?.get('x-trino-source')).toBe('hubble');
  });
});

describe('TrinoClient error parsing', () => {
  it('maps a Trino error payload to AppError with line/column/name', async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            id: 'q1',
            stats: { state: 'FAILED' },
            error: {
              message: "line 1:8: mismatched input 'FROM'",
              errorName: 'SYNTAX_ERROR',
              errorCode: 1,
              errorLocation: { lineNumber: 1, columnNumber: 8 },
            },
          }),
          { status: 200 },
        ),
      )) as unknown as typeof fetch;

    await expect(
      client(fetchImpl).start('SELECT FROM', {}, emptySessionMutations()),
    ).rejects.toMatchObject({
      status: 400,
      detail: {
        code: 'TRINO_ERROR',
        trinoErrorName: 'SYNTAX_ERROR',
        line: 1,
        column: 8,
      },
    });
  });

  it('raises a transport error (502) on a non-2xx without a structured error', async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        new Response('Service Unavailable', { status: 503 }),
      )) as unknown as typeof fetch;
    const err = await client(fetchImpl)
      .start('SELECT 1', {}, emptySessionMutations())
      .catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.status).toBe(502);
  });
});

describe('TrinoClient numeric parsing', () => {
  it('preserves lossy result numbers as their original decimal tokens', async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        new Response(
          '{"id":"q1","columns":[{"name":"large","type":"bigint"},{"name":"ratio","type":"decimal(38,16)"},{"name":"small","type":"double"}],"data":[[9007199254740993,1.0000000000000001,0.1]],"stats":{"state":"FINISHED","processedRows":9007199254740993}}',
          { status: 200 },
        ),
      )) as unknown as typeof fetch;

    const response = await client(fetchImpl).start('SELECT metrics', {}, emptySessionMutations());

    expect(response.data).toEqual([['9007199254740993', '1.0000000000000001', 0.1]]);
    expect(response.stats?.processedRows).toBeTypeOf('number');
  });
});

describe('TrinoClient session header parsing', () => {
  it('collects x-trino-set-catalog/schema/session and clear-session', async () => {
    const headers = new Headers();
    headers.set('x-trino-set-catalog', 'mysql');
    headers.set('x-trino-set-schema', 'app');
    headers.set('x-trino-set-session', 'optimize_hash_generation=true');
    headers.set('x-trino-clear-session', 'legacy_prop');
    const fetchImpl = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ id: 'q1', stats: { state: 'FINISHED' } }), {
          status: 200,
          headers,
        }),
      )) as unknown as typeof fetch;

    const mutations = emptySessionMutations();
    await client(fetchImpl).start('SET CATALOG mysql', {}, mutations);
    expect(mutations.setCatalog).toBe('mysql');
    expect(mutations.setSchema).toBe('app');
    expect(mutations.setSession.optimize_hash_generation).toBe('true');
    expect(mutations.clearSession).toContain('legacy_prop');
  });
});
