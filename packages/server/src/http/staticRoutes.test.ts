import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiRoutes } from '@hue-fable/contracts';
import { createTestContext } from '../test/harness';
import { cacheControlFor } from './staticRoutes';

/**
 * Static serving + SPA fallback (design.md §3 deployment). A throwaway dir holds
 * an index.html and a hashed asset; we assert files are served, unknown non-API
 * paths fall back to index.html, and `/api/*` is never intercepted.
 */
describe('STATIC_DIR serving', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hubble-static-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Hubble</title>');
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'assets', 'app-abc123.js'), 'console.log("hi")');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function ctx() {
    return createTestContext({ configOverrides: { staticDir: dir } });
  }

  it('serves index.html at the root with a no-cache header', async () => {
    const { app } = ctx();
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(await res.text()).toContain('Hubble');
  });

  it('serves a hashed asset with an immutable cache header', async () => {
    const { app } = ctx();
    const res = await app.request('/assets/app-abc123.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await res.text()).toContain('console.log');
  });

  it('falls back to index.html for an unknown (deep-link) path', async () => {
    const { app } = ctx();
    const res = await app.request('/notebooks/some-id');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(await res.text()).toContain('Hubble');
  });

  it('does not intercept /api routes (healthz still answers)', async () => {
    const { app } = ctx();
    const res = await app.request(apiRoutes.healthz());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('returns the JSON error envelope for unknown /api routes, not the SPA shell', async () => {
    const { app } = ctx();
    const res = await app.request('/api/does-not-exist');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('does not serve anything when STATIC_DIR is unset', async () => {
    const { app } = createTestContext();
    const res = await app.request('/');
    // No static dir → the catch-all never matches a file, so the root 404s.
    expect(res.status).toBe(404);
  });
});

describe('cacheControlFor', () => {
  it('marks index.html no-cache and everything else immutable', () => {
    expect(cacheControlFor('/srv/web/dist/index.html')).toBe('no-cache');
    expect(cacheControlFor('C:\\web\\dist\\index.html')).toBe('no-cache');
    expect(cacheControlFor('/srv/web/dist/assets/app-abc123.js')).toBe(
      'public, max-age=31536000, immutable',
    );
  });
});
