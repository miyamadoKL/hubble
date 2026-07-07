/**
 * AI アシスタントのオーケストレーション層。
 *
 * prompt 組み立て、provider 呼び出し、SSE イベント生成、監査ログ記録を担う。
 * prompt 本文と応答本文は監査ログに保存しない。
 */
import { createHash } from 'node:crypto';
import type { AiAssistEvent, AiAssistRequest } from '@hubble/contracts';
import { AppError } from '../errors';
import type { AuditLogger } from '../audit';
import { toErrorResponse } from '../errors';
import type { AiProvider } from './provider';
import { buildPrompt, extractSql } from './prompts';

type SqlDialect = 'trino' | 'mysql' | 'postgresql';

export interface AiServiceOptions {
  provider: AiProvider;
  audit: AuditLogger;
  timeoutMs: number;
}

/** AI アシスト要求を処理し、SSE イベント列を生成するサービス。 */
export class AiService {
  private readonly provider: AiProvider;
  private readonly audit: AuditLogger;
  private readonly timeoutMs: number;
  constructor(options: AiServiceOptions) {
    this.provider = options.provider;
    this.audit = options.audit;
    this.timeoutMs = options.timeoutMs;
  }

  /**
   * AI アシストを実行し、delta/done/error イベントを順に yield する。
   *
   * @param request - アシストリクエスト。
   * @param opts - 実行者、datasource、方言、中断 signal。
   * @yields SSE 配信用の AI イベント。
   */
  async *assist(
    request: AiAssistRequest,
    opts: {
      actor: string;
      datasourceId: string;
      dialect: SqlDialect;
      signal?: AbortSignal;
    },
  ): AsyncIterable<AiAssistEvent> {
    const prompt = buildPrompt(request, opts.dialect);
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal =
      opts.signal === undefined ? timeoutSignal : AbortSignal.any([opts.signal, timeoutSignal]);

    let fullText = '';
    let ok = false;
    let sqlHash: string | undefined;

    if (request.sql !== undefined) {
      sqlHash = createHash('sha256').update(request.sql).digest('hex').slice(0, 16);
    }

    try {
      for await (const chunk of this.provider.stream(prompt, signal)) {
        fullText += chunk;
        yield { type: 'delta', text: chunk };
      }
      ok = true;

      if (request.task === 'fix' || request.task === 'draft' || request.task === 'rewrite') {
        const sql = extractSql(fullText);
        yield { type: 'done', text: fullText, ...(sql !== undefined ? { sql } : {}) };
      } else {
        yield { type: 'done', text: fullText };
      }
    } catch (err) {
      const { detail } = err instanceof AppError ? { detail: err.detail } : toErrorResponse(err);
      yield { type: 'error', error: detail };
    } finally {
      await this.audit.record({
        actor: opts.actor,
        action: 'ai.assist',
        datasource: opts.datasourceId,
        detail: {
          task: request.task,
          provider: this.provider.kind,
          model: this.provider.model,
          ok,
          textLength: fullText.length,
          ...(sqlHash !== undefined ? { sqlHash } : {}),
        },
      });
    }
  }
}
