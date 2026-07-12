/**
 * app.ts (createApp) の疎通テスト。
 *
 * `test/harness.ts` の `createTestContext` でフェイク Trino + インメモリ SQLite を
 * 使ったテスト用アプリを構築し、app.ts で配線した「骨格」部分（healthz / config /
 * 未知ルートの 404 エラーエンベロープ）が期待通り機能することを確認する。
 * 各ドメインルーター自体の詳細な挙動は http/*.test.ts 側の責務。
 */
import { describe, it, expect, vi } from 'vitest';
import { appConfigSchema, apiRoutes } from '@hubble/contracts';
import { createTestContext } from './test/harness';

const EXPECTED_SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy':
    'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
  'cross-origin-opener-policy': 'same-origin',
} as const;

/** 共通 security header がすべて設定され、CSP は未設定であることを確認する。 */
function expectSecurityHeaders(res: Response): void {
  for (const [name, value] of Object.entries(EXPECTED_SECURITY_HEADERS)) {
    expect(res.headers.get(name)).toBe(value);
  }
  expect(res.headers.get('content-security-policy')).toBeNull();
}

describe('GET /api/healthz', () => {
  // 認証ミドルウェアより前段で応答すること（常に 200 かつ { status: 'ok' }）を確認。
  it('returns ok', async () => {
    const { app } = await createTestContext();
    const res = await app.request(apiRoutes.healthz());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});

describe('GET /api/readyz', () => {
  it('DBと既定エンジンが利用可能なら200を返す', async () => {
    const { app } = await createTestContext();
    const res = await app.request(apiRoutes.readyz());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'ok',
      checks: { database: 'ok', defaultEngine: 'ok' },
    });
  });

  it('依存障害時は503を返してもlivenessは成功する', async () => {
    const { app, services } = await createTestContext();
    vi.spyOn(services.readiness, 'check').mockResolvedValue({
      ready: false,
      checks: { database: 'failed', defaultEngine: 'ok' },
    });

    expect((await app.request(apiRoutes.readyz())).status).toBe(503);
    expect((await app.request(apiRoutes.healthz())).status).toBe(200);
  });
});

describe('GET /api/config', () => {
  // 環境変数デフォルト値から組み立てた AppConfig が公開契約スキーマを満たし、
  // 代表的なフィールド（trino.user / defaults.limit / version）が期待値であることを検証。
  it('returns a contract-valid AppConfig with env defaults', async () => {
    const { app } = await createTestContext();
    const res = await app.request(apiRoutes.config());
    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = appConfigSchema.parse(body);
    expect(parsed.trino.user).toBe('admin');
    expect(parsed.defaults.limit).toBe(5000);
    expect(parsed.version).toBe('0.1.0');
  });
});

describe('unknown /api route', () => {
  // どのドメインルーターにもマッチしない /api パスが、SPA フォールバックではなく
  // 統一エラーエンベロープ（404 / NOT_FOUND）として返ることを確認。
  it('returns a 404 error envelope', async () => {
    const { app } = await createTestContext();
    const res = await app.request('/api/does-not-exist');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });
});

describe('API request body limit', () => {
  it('rejects an oversized body before JSON parsing', async () => {
    const { app } = await createTestContext({
      configOverrides: { http: { maxBodyBytes: 64 } },
    });
    const res = await app.request('/api/queries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ statement: `SELECT '${'x'.repeat(128)}'` }),
    });

    expect(res.status).toBe(413);
    expect((await res.json()) as unknown).toMatchObject({
      error: { code: 'PAYLOAD_TOO_LARGE' },
    });
  });
});

describe('response security headers', () => {
  it.each([apiRoutes.healthz(), apiRoutes.readyz(), apiRoutes.config(), '/api/does-not-exist'])(
    'sets low-risk headers on %s',
    async (path) => {
      const { app } = await createTestContext();
      const res = await app.request(path);
      expectSecurityHeaders(res);
    },
  );
});

describe('CSRF boundary', () => {
  const endpoint = 'https://hubble.example/api/queries';
  const invalidQueryBody = JSON.stringify({});

  it('rejects an unsafe cross-site Fetch Metadata request before body parsing', async () => {
    const { app } = await createTestContext();
    const res = await app.request(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'Sec-Fetch-Site': 'cross-site',
      },
      body: invalidQueryBody,
    });

    expect(res.status).toBe(403);
    expect((await res.json()) as unknown).toMatchObject({ error: { code: 'CSRF_REJECTED' } });
    expectSecurityHeaders(res);
  });

  it('rejects an unsafe request with a mismatched Origin', async () => {
    const { app } = await createTestContext();
    const res = await app.request(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        Origin: 'https://other.example',
      },
      body: invalidQueryBody,
    });

    expect(res.status).toBe(403);
    expect((await res.json()) as unknown).toMatchObject({ error: { code: 'CSRF_REJECTED' } });
  });

  it.each([
    {
      name: 'same-origin metadata',
      headers: {
        'Content-Type': 'text/plain',
        Origin: 'https://hubble.example',
        'Sec-Fetch-Site': 'same-origin',
      },
    },
    { name: 'missing metadata', headers: { 'Content-Type': 'text/plain' } },
  ])('allows $name to reach the existing validator', async ({ headers }) => {
    const { app } = await createTestContext();
    const res = await app.request(endpoint, {
      method: 'POST',
      headers,
      body: invalidQueryBody,
    });

    expect(res.status).toBe(400);
    expect((await res.json()) as unknown).toMatchObject({
      error: { code: 'VALIDATION_ERROR' },
    });
  });

  it('allows an unsafe same-host request behind a TLS-terminating proxy', async () => {
    const { app } = await createTestContext();
    const res = await app.request('http://hubble.example/api/queries', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://hubble.example',
        'Sec-Fetch-Site': 'same-origin',
      },
      body: invalidQueryBody,
    });

    expect(res.status).toBe(400);
    expect((await res.json()) as unknown).toMatchObject({
      error: { code: 'VALIDATION_ERROR' },
    });
  });

  it.each(['GET', 'HEAD', 'OPTIONS'] as const)(
    'does not reject the safe %s method with cross-site metadata',
    async (method) => {
      const { app } = await createTestContext();
      const res = await app.request('https://hubble.example/api/does-not-exist', {
        method,
        headers: { 'Sec-Fetch-Site': 'cross-site' },
      });

      expect(res.status).not.toBe(403);
    },
  );
});
