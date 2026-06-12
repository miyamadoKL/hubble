import { describe, it, expect } from 'vitest';
import { appConfigSchema, apiRoutes } from '@hubble/contracts';
import { createTestContext } from './test/harness';

describe('GET /api/healthz', () => {
  it('returns ok', async () => {
    const { app } = await createTestContext();
    const res = await app.request(apiRoutes.healthz());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});

describe('GET /api/config', () => {
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
  it('returns a 404 error envelope', async () => {
    const { app } = await createTestContext();
    const res = await app.request('/api/does-not-exist');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });
});
