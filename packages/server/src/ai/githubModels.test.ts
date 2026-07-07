import { describe, expect, it } from 'vitest';
import { GithubModelsProvider } from './githubModels';

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

describe('GithubModelsProvider', () => {
  it('yields text fragments from SSE chunks', async () => {
    const provider = new GithubModelsProvider({
      model: 'openai/gpt-4o-mini',
      apiKey: 'test-token',
      baseUrl: 'https://models.test/chat/completions',
      fetchImpl: (async (input, init) => {
        expect(String(input)).toBe('https://models.test/chat/completions');
        expect(init?.headers).toMatchObject({ authorization: 'Bearer test-token' });
        return sseResponse([
          'data: {"choices":[{"delta":{"content":"SELECT "}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"1"}}]}\n\n',
          'data: [DONE]\n\n',
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
    expect(parts).toEqual(['SELECT ', '1']);
  });

  it('throws AppError(502) on non-2xx responses', async () => {
    const provider = new GithubModelsProvider({
      model: 'openai/gpt-4o-mini',
      apiKey: 'test-token',
      baseUrl: 'https://models.test/chat/completions',
      fetchImpl: (async () => sseResponse(['upstream failure'], 502)) as typeof fetch,
    });

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
