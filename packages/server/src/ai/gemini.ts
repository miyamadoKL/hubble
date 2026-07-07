/**
 * Google Gemini API を使った AI provider 実装。
 *
 * `streamGenerateContent` エンドポイントへ SSE 形式でリクエストし、
 * 応答テキストの増分を逐次 yield する。
 */
import { AppError } from '../errors';
import type { AiPrompt, AiProvider } from './provider';
import { parseSseDataLines } from './sse';

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';

export interface GeminiProviderOptions {
  model: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

/** Gemini API provider。 */
export class GeminiProvider implements AiProvider {
  readonly kind = 'gemini-api' as const;
  readonly model: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(options: GeminiProviderOptions) {
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  }

  async *stream(prompt: AiPrompt, signal: AbortSignal): AsyncIterable<string> {
    const url =
      `${this.baseUrl}/v1beta/models/${encodeURIComponent(this.model)}` +
      ':streamGenerateContent?alt=sse';
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': this.apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: prompt.system }] },
        contents: [{ role: 'user', parts: [{ text: prompt.user }] }],
      }),
      signal,
    });

    if (!response.ok) {
      throw await providerError(response);
    }
    if (response.body === null) {
      throw new AppError(502, {
        code: 'AI_PROVIDER_ERROR',
        message: 'Gemini API returned an empty response body',
      });
    }

    for await (const data of parseSseDataLines(response.body)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      const text = extractGeminiText(parsed);
      if (text !== undefined && text.length > 0) {
        yield text;
      }
    }
  }
}

/** Gemini SSE ペイロードからテキスト断片を取り出す。 */
function extractGeminiText(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const candidates = (payload as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return undefined;
  const content = (candidates[0] as { content?: { parts?: unknown } }).content;
  const parts = content?.parts;
  if (!Array.isArray(parts)) return undefined;
  const chunks: string[] = [];
  for (const part of parts) {
    const text = (part as { text?: unknown }).text;
    if (typeof text === 'string' && text.length > 0) {
      chunks.push(text);
    }
  }
  if (chunks.length === 0) return undefined;
  return chunks.join('');
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
    message: `Gemini API request failed with status ${response.status}${suffix}`,
  });
}
