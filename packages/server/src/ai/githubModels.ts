/**
 * GitHub Models REST API を使った AI provider 実装。
 *
 * OpenAI 互換の chat completions エンドポイントへ SSE 形式でリクエストし、
 * 応答テキストの増分を逐次 yield する。
 */
import { AppError } from '../errors';
import type { AiPrompt, AiProvider } from './provider';
import { parseSseDataLines } from './sse';

const DEFAULT_BASE_URL = 'https://models.github.ai/inference/chat/completions';

export interface GithubModelsProviderOptions {
  model: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

/** GitHub Models provider。 */
export class GithubModelsProvider implements AiProvider {
  readonly kind = 'github-models' as const;
  readonly model: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(options: GithubModelsProviderOptions) {
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  }

  async *stream(prompt: AiPrompt, signal: AbortSignal): AsyncIterable<string> {
    const response = await this.fetchImpl(this.baseUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        stream: true,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
      }),
      signal,
    });

    if (!response.ok) {
      throw await providerError(response);
    }
    if (response.body === null) {
      throw new AppError(502, {
        code: 'AI_PROVIDER_ERROR',
        message: 'GitHub Models API returned an empty response body',
      });
    }

    for await (const data of parseSseDataLines(response.body)) {
      if (data.trim() === '[DONE]') return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      const text = extractDeltaContent(parsed);
      if (text !== undefined && text.length > 0) {
        yield text;
      }
    }
  }
}

/** GitHub Models SSE ペイロードから delta content を取り出す。 */
function extractDeltaContent(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const delta = (choices[0] as { delta?: { content?: unknown } }).delta;
  const content = delta?.content;
  return typeof content === 'string' ? content : undefined;
}

/** 非 2xx レスポンスを AppError に変換する（API key はメッセージに含めない）。 */
async function providerError(response: Response): Promise<AppError> {
  let snippet = '';
  try {
    snippet = (await response.text()).slice(0, 500);
  } catch {
    // レスポンスボディ読み取り失敗時は snippet 空のままにする。
  }
  const suffix = snippet ? `: ${snippet}` : '';
  return new AppError(502, {
    code: 'AI_PROVIDER_ERROR',
    message: `GitHub Models API request failed with status ${response.status}${suffix}`,
  });
}
