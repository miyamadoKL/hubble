/**
 * app.ts (createApp) の疎通テスト。
 *
 * `test/harness.ts` の `createTestContext` でフェイク Trino + インメモリ SQLite を
 * 使ったテスト用アプリを構築し、app.ts で配線した「骨格」部分（healthz / config /
 * 未知ルートの 404 エラーエンベロープ）が期待通り機能することを確認する。
 * 各ドメインルーター自体の詳細な挙動は http/*.test.ts 側の責務。
 */
import { describe, it, expect } from 'vitest';
import { appConfigSchema, apiRoutes } from '@hubble/contracts';
import { createTestContext } from './test/harness';

describe('GET /api/healthz', () => {
  // 認証ミドルウェアより前段で応答すること（常に 200 かつ { status: 'ok' }）を確認。
  it('returns ok', async () => {
    const { app } = await createTestContext();
    const res = await app.request(apiRoutes.healthz());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
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
