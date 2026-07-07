import { describe, expect, it } from 'vitest';
import { AppError } from '../errors';
import { GeminiProvider } from './gemini';

function sseResponse(chunks: string[], status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } });
}

describe('GeminiProvider', () => {
  it('yields text fragments from SSE chunks', async () => {
    const provider = new GeminiProvider({
      model: 'gemini-2.5-flash',
      apiKey: 'test-key',
      baseUrl: 'https://gemini.test',
      fetchImpl: (async (input, init) => {
        expect(String(input)).toBe(
          'https://gemini.test/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse',
        );
        expect(init?.headers).toMatchObject({ 'x-goog-api-key': 'test-key' });
        return sseResponse([
          'data: {"candidates":[{"content":{"parts":[{"text":"Hello "}]}}]}\n\n',
          'data: {"candidates":[{"content":{"parts":[{"text":"world"}]}}]}\n\n',
        ]);
      }) as typeof fetch,
    });

    const parts: string[] = [];
    for await (const text of provider.stream(
      { system: 'sys', user: 'user' },
      new AbortController().signal,
    )) {
      parts.push(text);
    }
    expect(parts).toEqual(['Hello ', 'world']);
  });

  it('throws AppError(502) on non-2xx responses', async () => {
    const provider = new GeminiProvider({
      model: 'gemini-2.5-flash',
      apiKey: 'test-key',
      baseUrl: 'https://gemini.test',
      fetchImpl: (async () => sseResponse(['upstream failure'], 503)) as typeof fetch,
    });

    const stream = provider.stream({ system: 'sys', user: 'user' }, new AbortController().signal);
    await expect(async () => {
      for await (const part of stream) {
        void part;
      }
    }).rejects.toBeInstanceOf(AppError);

    await expect(async () => {
      for await (const part of provider.stream(
        { system: 'sys', user: 'user' },
        new AbortController().signal,
      )) {
        void part;
      }
    }).rejects.toMatchObject({
      status: 502,
      detail: { code: 'AI_PROVIDER_ERROR' },
    });
  });
});
