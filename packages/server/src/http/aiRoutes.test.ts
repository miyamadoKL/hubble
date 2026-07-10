import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AI_DISABLED, apiRoutes } from '@hubble/contracts';
import { createTestContext } from '../test/harness';
import type { AiProvider } from '../ai/provider';
import { AiRateLimiter } from '../ai/rateLimiter';

const enabledAiConfig = {
  provider: 'gemini-api' as const,
  model: 'gemini-2.5-flash',
  apiKey: 'secret',
  timeoutMs: 60_000,
  maxConcurrency: 4,
  perPrincipalPerMinute: 20,
  maxResponseBytes: 262_144,
  maxOutputTokens: 2_048,
};

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
        ai: enabledAiConfig,
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
        ai: enabledAiConfig,
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
        ai: enabledAiConfig,
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

  it('aborts an oversized provider response and audits it as failed', async () => {
    let providerAborted = false;
    const provider: AiProvider = {
      kind: 'gemini-api',
      model: 'test-model',
      async *stream(_prompt, signal) {
        try {
          yield 'あ';
          yield 'い';
          yield 'う';
        } finally {
          providerAborted = signal.aborted;
        }
      },
    };
    const ctx = await createTestContext({
      configOverrides: {
        ai: { ...enabledAiConfig, maxResponseBytes: 4 },
      },
      aiProvider: provider,
    });

    const events = [];
    for await (const event of ctx.services.ai!.assist(
      { task: 'explain', sql: 'SELECT 1' },
      { actor: 'alice', datasourceId: 'trino-default', dialect: 'trino' },
    )) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'delta', text: 'あ' },
      {
        type: 'error',
        error: {
          code: 'AI_RESPONSE_TOO_LARGE',
          message: 'AI provider response exceeded the configured size limit',
        },
      },
    ]);
    expect(providerAborted).toBe(true);
    const auditRows = await ctx.services.audit.listForTest();
    expect(auditRows.at(-1)?.detail).toMatchObject({ ok: false, textLength: 1 });
  });

  it('returns principal rate limit errors as HTTP 429 before SSE starts', async () => {
    let now = 10_000;
    const ctx = await createTestContext({
      configOverrides: { ai: enabledAiConfig },
      aiProvider: fakeProvider(['ok']),
    });
    ctx.services.aiRateLimiter = new AiRateLimiter({
      maxConcurrency: 2,
      perPrincipalPerMinute: 1,
      now: () => now,
    });
    const request = async (): Promise<Response> =>
      await ctx.app.request(apiRoutes.aiAssist(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ task: 'explain', sql: 'SELECT 1' }),
      });

    const first = await request();
    expect(first.status).toBe(200);
    await first.text();
    const rejected = await request();
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get('retry-after')).toBe('60');
    expect(rejected.headers.get('content-type')).toContain('application/json');
    expect(await rejected.json()).toMatchObject({ error: { code: 'AI_RATE_LIMITED' } });

    now += 60_001;
    const accepted = await request();
    expect(accepted.status).toBe(200);
    await accepted.text();
  });

  it('holds the global concurrency slot until the stream releases it', async () => {
    let continueFirst!: () => void;
    let markStarted!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => {
      continueFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let calls = 0;
    const provider: AiProvider = {
      kind: 'gemini-api',
      model: 'test-model',
      async *stream() {
        calls += 1;
        if (calls === 1) {
          markStarted();
          await firstMayFinish;
        }
        yield 'ok';
      },
    };
    const ctx = await createTestContext({
      configOverrides: { ai: { ...enabledAiConfig, maxConcurrency: 1 } },
      aiProvider: provider,
    });
    const request = async (): Promise<Response> =>
      await ctx.app.request(apiRoutes.aiAssist(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ task: 'explain', sql: 'SELECT 1' }),
      });

    const firstResponse = await request();
    const firstBody = firstResponse.text();
    await firstStarted;
    const rejected = await request();
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get('retry-after')).toBe('1');

    continueFirst();
    await firstBody;
    const accepted = await request();
    expect(accepted.status).toBe(200);
    await accepted.text();
  });
});
