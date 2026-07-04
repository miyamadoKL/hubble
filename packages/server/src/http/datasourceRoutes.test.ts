import { describe, it, expect } from 'vitest';
import { datasourcesResponseSchema, apiRoutes } from '@hubble/contracts';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTestContext } from '../test/harness';

describe('GET /api/datasources', () => {
  it('returns datasource summaries without secrets or connection details', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'hubble-ds-route-'));
    try {
      writeFileSync(
        join(tempDir, 'datasources.yaml'),
        `datasources:
  - id: trino-prod
    type: trino
    displayName: Production Trino
    username: trino-user
    passwordEnv: TRINO_SECRET
    baseUrl: http://trino:8080
  - id: mysql-analytics
    type: mysql
    username: mysql-user
    host: mysql.internal
    database: analytics
`,
        'utf8',
      );

      const { app } = await createTestContext({
        env: { DATASOURCES_PATH: 'datasources.yaml', TRINO_SECRET: 'hidden' },
        cwd: tempDir,
      });

      const res = await app.request(apiRoutes.datasources());
      expect(res.status).toBe(200);

      const body = datasourcesResponseSchema.parse(await res.json());
      expect(body.datasources).toEqual([
        {
          id: 'trino-prod',
          kind: 'trino',
          displayName: 'Production Trino',
          capabilities: { costEstimate: true, catalogs: true },
        },
        {
          id: 'mysql-analytics',
          kind: 'mysql',
          displayName: 'mysql-analytics',
          capabilities: { costEstimate: false, catalogs: false },
        },
      ]);

      const raw = JSON.stringify(body);
      expect(raw).not.toContain('hidden');
      expect(raw).not.toContain('mysql.internal');
      expect(raw).not.toContain('http://trino:8080');
      expect(raw).not.toContain('password');
      expect(raw).not.toContain('username');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('throws a startup error when datasources.yaml is missing (no TRINO_* fallback)', async () => {
    // Postgres ファースト移行により、TRINO_* 環境変数から trino-default を
    // 自動合成する後方互換フォールバックは廃止された。datasources.yaml が
    // 存在しない状態で起動しようとすると、明確な日本語エラーで即座に失敗する。
    const tempDir = mkdtempSync(join(tmpdir(), 'hubble-ds-missing-'));
    try {
      await expect(
        createTestContext({
          env: { DATASOURCES_PATH: 'datasources.yaml' },
          cwd: tempDir,
        }),
      ).rejects.toThrow(
        'datasources.yaml が見つからない。DATASOURCES_PATH で指定するか ./datasources.yaml を作成せよ',
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
