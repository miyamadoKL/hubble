// query APIのキャンセル応答とHTTPエラー変換を検証する。
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiClientError } from '../api/client';
import { cancelQuery } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('cancelQuery', () => {
  test.each([204, 404])('%iを成功として扱う', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status })));

    await expect(cancelQuery('q1')).resolves.toBeUndefined();
  });

  test.each([403, 500])('%iのエラー応答を呼び出し元へ伝える', async (status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'denied' } }), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const error = await cancelQuery('q1').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).toMatchObject({ status, message: 'denied' });
  });

  test('network failureを呼び出し元へ伝える', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));

    await expect(cancelQuery('q1')).rejects.toThrow('offline');
  });
});
