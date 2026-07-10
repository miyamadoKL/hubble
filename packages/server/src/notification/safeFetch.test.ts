/**
 * Webhook egress ガードの URL、DNS、接続時検証を確認する。
 */
import http from 'node:http';
import type { LookupFunction } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseCidrList } from '../auth/cidr';
import { createSafeFetch, type SafeFetch, type SafeFetchOptions } from './safeFetch';

const PUBLIC_ADDRESS = [{ address: '93.184.216.34', family: 4 }];
const trackedFetches: SafeFetch[] = [];

function safeFetch(options: Partial<SafeFetchOptions> = {}): SafeFetch {
  const instance = createSafeFetch({
    allowedCidrs: [],
    allowHttp: false,
    timeoutMs: 1_000,
    lookup: async () => PUBLIC_ADDRESS,
    fetchImpl: vi.fn<typeof fetch>(async () => new Response(null, { status: 204 })),
    ...options,
  });
  trackedFetches.push(instance);
  return instance;
}

afterEach(async () => {
  await Promise.all(trackedFetches.splice(0).map((instance) => instance.close()));
});

describe('createSafeFetch', () => {
  it.each([
    'https://127.0.0.1/hook',
    'https://169.254.169.254/latest/meta-data',
    'https://10.2.3.4/hook',
    'https://[::1]/hook',
    'https://[::ffff:127.0.0.1]/hook',
  ])('rejects a reserved literal address before POST: %s', async (url) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const guarded = safeFetch({ fetchImpl });

    await expect(guarded(url, { method: 'POST' })).rejects.toThrow(
      'Webhook destination is not allowed',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('allows a public literal address and a public hostname', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    const lookup = vi.fn(async () => PUBLIC_ADDRESS);
    const guarded = safeFetch({ fetchImpl, lookup });

    await expect(guarded('https://93.184.216.34/hook')).resolves.toMatchObject({ status: 204 });
    await expect(guarded('https://hooks.example.com/hook')).resolves.toMatchObject({ status: 204 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(lookup).toHaveBeenCalledOnce();
  });

  it('rejects http by default and allows it only when configured', async () => {
    const deniedFetch = vi.fn<typeof fetch>();
    const denied = safeFetch({ fetchImpl: deniedFetch });
    await expect(denied('http://93.184.216.34/hook')).rejects.toThrow(
      'Webhook URL scheme is not allowed',
    );
    expect(deniedFetch).not.toHaveBeenCalled();

    const allowedFetch = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    const allowed = safeFetch({ fetchImpl: allowedFetch, allowHttp: true });
    await expect(allowed('http://93.184.216.34/hook')).resolves.toMatchObject({ status: 204 });
  });

  it('rejects a hostname when any resolved address is private', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const guarded = safeFetch({
      fetchImpl,
      lookup: async () => [...PUBLIC_ADDRESS, { address: '192.168.1.20', family: 4 }],
    });

    await expect(guarded('https://mixed.example.com/hook')).rejects.toThrow(
      'Webhook destination is not allowed',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not expose resolver details when hostname lookup fails', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const guarded = safeFetch({
      fetchImpl,
      lookup: async () => {
        throw new Error('resolver failed for secret.internal at 10.0.0.53');
      },
    });

    await expect(guarded('https://secret.internal/hook')).rejects.toThrow(
      'Webhook destination could not be verified',
    );
    await expect(guarded('https://secret.internal/hook')).rejects.not.toThrow('10.0.0.53');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('allows a reserved address when an operator CIDR includes it', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    const guarded = safeFetch({
      fetchImpl,
      allowedCidrs: parseCidrList('10.0.0.0/8'),
    });

    await expect(guarded('https://10.2.3.4/hook')).resolves.toMatchObject({ status: 204 });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('sets redirect error mode and rejects a 3xx response', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(null, { status: 302, headers: { location: 'https://example.com/next' } }),
    );
    const guarded = safeFetch({ fetchImpl });

    await expect(guarded('https://93.184.216.34/hook')).rejects.toThrow(
      'Webhook redirect is not allowed',
    );
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' });
  });

  it('aborts a webhook after the configured timeout', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const guarded = safeFetch({ fetchImpl, timeoutMs: 10 });

    await expect(guarded('https://93.184.216.34/hook')).rejects.toThrow(
      'Webhook request timed out',
    );
  });

  it('blocks a private address returned only by the connection-time lookup', async () => {
    let requests = 0;
    const server = http.createServer((_request, response) => {
      requests += 1;
      response.end('unexpected');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not start');
    const connectionLookup: LookupFunction = (_hostname, _options, callback) => {
      callback(null, [{ address: '127.0.0.1', family: 4 }]);
    };
    const guarded = safeFetch({
      fetchImpl: fetch,
      allowHttp: true,
      connectionLookup,
    });

    try {
      await expect(guarded(`http://rebind.test:${address.port}/hook`)).rejects.toThrow(
        'Webhook destination is not allowed',
      );
      expect(requests).toBe(0);
    } finally {
      await guarded.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('does not follow a redirect with the real fetch implementation', async () => {
    const paths: string[] = [];
    const server = http.createServer((request, response) => {
      paths.push(request.url ?? '');
      if (request.url === '/start') {
        response.writeHead(302, { location: '/target' });
      } else {
        response.writeHead(204);
      }
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not start');
    const connectionLookup: LookupFunction = (_hostname, _options, callback) => {
      callback(null, [{ address: '127.0.0.1', family: 4 }]);
    };
    const guarded = safeFetch({
      fetchImpl: fetch,
      allowHttp: true,
      allowedCidrs: parseCidrList('127.0.0.0/8'),
      connectionLookup,
    });

    try {
      await expect(guarded(`http://redirect.test:${address.port}/start`)).rejects.toThrow(
        'Webhook redirect is not allowed',
      );
      expect(paths).toEqual(['/start']);
    } finally {
      await guarded.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
