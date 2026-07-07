import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AI_DISABLED, apiRoutes } from '@hubble/contracts';
import { createTestContext } from '../test/harness';
import type { AiProvider } from '../ai/provider';

function parseSseBody(body: string): Array<{ event: string; data: unknown }> {
  const frames = body
    .split('\n\n')
    .filter((frame) => frame.trim() !== '' && !frame.startsWith(':'));
  return frames.map((frame) => {
    const lines = frame.split('\n');
    const eventLine = lines.find((line) => line.startsWith('event:'));
    const dataLine = lines.find((line) => line.startsWith('data:'));
    return {
      event: eventLine?.slice('event:'.length).trim() ?? '',
      data: JSON.parse(dataLine?.slice('data:'.length).trim() ?? 'null'),
    };
  });
}

function fakeProvider(chunks: string[]): AiProvider {
  return {
    kind: 'gemini-api',
    model: 'test-model',
    async *stream() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

describe('POST /api/ai/assist', () => {
  it('returns 501 AI_DISABLED when provider is off', async () => {
    const ctx = await createTestContext({
      configOverrides: { ai: { provider: 'off' } },
    });
    const res = await ctx.app.request(apiRoutes.aiAssist(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'explain', sql: 'SELECT 1' }),
    });
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({
      error: { code: AI_DISABLED, message: 'AI assistant is not configured' },
    });
  });

  it('returns 403 when role lacks ai.use', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hubble-ai-rbac-'));
    const rbacPath = join(dir, 'rbac.yaml');
    writeFileSync(
      rbacPath,
      `roles:
  member:
    permissions: []
assignments:
  - user: local-dev
    role: member
defaultRole: member
`,
      'utf8',
    );
    const ctx = await createTestContext({
      env: { RBAC_PATH: rbacPath },
      cwd: dir,
      configOverrides: {
        ai: {
          provider: 'gemini-api',
          model: 'gemini-2.5-flash',
          apiKey: 'secret',
          timeoutMs: 60_000,
        },
      },
      aiProvider: fakeProvider(['ok']),
    });
    try {
      const res = await ctx.app.request(apiRoutes.aiAssist(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ task: 'explain', sql: 'SELECT 1' }),
      });
      expect(res.status).toBe(403);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('streams delta and done events and records audit', async () => {
    const ctx = await createTestContext({
      configOverrides: {
        ai: {
          provider: 'gemini-api',
          model: 'gemini-2.5-flash',
          apiKey: 'secret',
          timeoutMs: 60_000,
        },
      },
      aiProvider: fakeProvider(['Here is the fix:\n\n', '```sql\n', 'SELECT 1\n', '```']),
    });

    const res = await ctx.app.request(apiRoutes.aiAssist(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        task: 'fix',
        sql: 'SELECT bad',
        errorMessage: 'column bad does not exist',
      }),
    });
    expect(res.status).toBe(200);

    const body = await res.text();
    const events = parseSseBody(body);
    const deltas = events.filter((event) => event.event === 'delta');
    const done = events.find((event) => event.event === 'done');
    expect(deltas.length).toBe(4);
    expect(done?.data).toMatchObject({
      type: 'done',
      text: 'Here is the fix:\n\n```sql\nSELECT 1\n```',
      sql: 'SELECT 1',
    });

    const auditRows = await ctx.services.audit.listForTest();
    expect(auditRows.some((row) => row.action === 'ai.assist')).toBe(true);
    const assist = auditRows.find((row) => row.action === 'ai.assist');
    expect(assist?.detail).toMatchObject({
      task: 'fix',
      provider: 'gemini-api',
      model: 'test-model',
      ok: true,
      sqlHash: expect.any(String),
    });
  });

  it('returns 400 VALIDATION_ERROR when fix lacks errorMessage', async () => {
    const ctx = await createTestContext({
      configOverrides: {
        ai: {
          provider: 'gemini-api',
          model: 'gemini-2.5-flash',
          apiKey: 'secret',
          timeoutMs: 60_000,
        },
      },
      aiProvider: fakeProvider(['ignored']),
    });

    const res = await ctx.app.request(apiRoutes.aiAssist(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'fix', sql: 'SELECT 1' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { code: 'VALIDATION_ERROR' },
    });
  });
});
