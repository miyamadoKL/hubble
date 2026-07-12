/**
 * GitHub Models REST API を使った AI provider 実装。
 *
 * OpenAI 互換の chat completions エンドポイントへ SSE 形式でリクエストし、
 * 応答テキストの増分を逐次 yield する。
 */
import { AppError } from '../errors';
import type { AiPrompt, AiProvider } from './provider';
import { invalidResponse, parseSseDataLines } from './sse';

const DEFAULT_BASE_URL = 'https://models.github.ai/inference/chat/completions';

export interface GithubModelsProviderOptions {
  model: string;
  apiKey: string;
  maxOutputTokens: number;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

/** GitHub Models provider。 */
export class GithubModelsProvider implements AiProvider {
  readonly kind = 'github-models' as const;
  readonly model: string;
  private readonly apiKey: string;
  private readonly maxOutputTokens: number;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(options: GithubModelsProviderOptions) {
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.maxOutputTokens = options.maxOutputTokens;
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
        max_tokens: this.maxOutputTokens,
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

    let completedNormally = false;
    for await (const data of parseSseDataLines(response.body)) {
      if (data.trim() === '[DONE]') {
        if (!completedNormally) {
          throw invalidResponse('GitHub Models SSE response ended without finish_reason=stop');
        }
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      const finishReason = extractFinishReason(parsed);
      if (finishReason !== undefined) {
        if (finishReason !== 'stop') {
          throw invalidResponse(`GitHub Models generation stopped with ${finishReason}`);
        }
        completedNormally = true;
      }
      const text = extractDeltaContent(parsed);
      if (text !== undefined && text.length > 0) {
        yield text;
      }
    }
    throw invalidResponse('GitHub Models SSE response ended before the [DONE] marker');
  }
}

/** GitHub Models SSE から最初の choice の終了理由を取り出す。 */
function extractFinishReason(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const reason = (choices[0] as { finish_reason?: unknown }).finish_reason;
  return typeof reason === 'string' && reason.length > 0 ? reason : undefined;
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
