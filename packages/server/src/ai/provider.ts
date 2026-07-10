/**
 * AI provider の共通インターフェースとファクトリ。
 *
 * 環境変数から解決した `AiConfig` を、実際にストリーミング推論を行う
 * provider 実装へ変換する。provider が `off` のときは undefined を返す。
 */
import type { AiConfig } from '../config';
import { GeminiProvider } from './gemini';
import { GithubModelsProvider } from './githubModels';

/** provider へ渡す prompt（system と user の 2 部構成）。 */
export interface AiPrompt {
  system: string;
  user: string;
}

/** ストリーミング推論を行う AI provider の共通インターフェース。 */
export interface AiProvider {
  readonly kind: 'gemini-api' | 'github-models';
  readonly model: string;
  /** prompt を送り、応答テキストの増分を順に yield する。 */
  stream(prompt: AiPrompt, signal: AbortSignal): AsyncIterable<string>;
}

/**
 * 設定から AI provider を生成する。
 *
 * @param config - サーバー設定の AI セクション。
 * @param fetchImpl - HTTP 呼び出しに使う fetch（テスト注入用）。
 * @returns provider が有効なら実装、off なら undefined。
 */
export function createAiProvider(
  config: AiConfig,
  fetchImpl: typeof fetch = fetch,
): AiProvider | undefined {
  if (config.provider === 'off') return undefined;
  if (config.provider === 'gemini-api') {
    return new GeminiProvider({
      model: config.model,
      apiKey: config.apiKey,
      maxOutputTokens: config.maxOutputTokens,
      fetchImpl,
    });
  }
  return new GithubModelsProvider({
    model: config.model,
    apiKey: config.apiKey,
    maxOutputTokens: config.maxOutputTokens,
    fetchImpl,
  });
}
