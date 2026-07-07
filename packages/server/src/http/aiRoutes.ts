/**
 * AI アシスタント API ルーター（`POST /api/ai/assist`）。
 *
 * 認可チェック、datasource 方言解決、SSE ストリーミング配信を担う。
 * LLM 呼び出し本体は `AiService` に委譲する。
 */
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { AI_DISABLED, aiAssistRequestSchema } from '@hubble/contracts';
import type { AiAssistEvent } from '@hubble/contracts';
import type { DatasourceKind } from '@hubble/contracts';
import type { Services } from '../services';
import type { AuthVariables } from '../auth/middleware';
import { AppError } from '../errors';
import { requirePermission, requireDatasourceAccess } from '../rbac/check';
import { parseJsonBody } from './validate';

const KEEPALIVE_INTERVAL_MS = 15_000;
const SSE_KEEPALIVE = ': keep-alive\n\n';

type SqlDialect = 'trino' | 'mysql' | 'postgresql';

/** datasource 種別から SQL 方言へ変換する。 */
function dialectForDatasource(type: DatasourceKind): SqlDialect {
  if (type === 'mysql') return 'mysql';
  if (type === 'postgresql') return 'postgresql';
  return 'trino';
}

/** AI SSE イベントを SSE フレーム文字列へ変換する。 */
function encodeAiSseEvent(event: AiAssistEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * AI アシスタント API ルーターを構築する。
 *
 * @param services - DI コンテナ。
 * @returns `/api/ai` 配下にマウントする Hono サブアプリケーション。
 */
export function aiRoutes(services: Services): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.post('/assist', async (c) => {
    requirePermission(c.var.principal.role, 'ai.use');

    // ローカル定数へ束縛して以降の narrowing を保つ（closure 内でも non-null 扱いにする）。
    const ai = services.ai;
    if (ai === undefined) {
      throw new AppError(501, {
        code: AI_DISABLED,
        message: 'AI assistant is not configured',
      });
    }

    const request = await parseJsonBody(c, aiAssistRequestSchema);
    const datasourceId = request.datasourceId ?? services.defaultDatasourceId;
    requireDatasourceAccess(c.var.principal.role, datasourceId);

    const datasource = services.datasources.find((ds) => ds.id === datasourceId);
    if (datasource === undefined) {
      throw AppError.notFound(`Datasource ${datasourceId} not found`);
    }
    const dialect = dialectForDatasource(datasource.type);

    return streamSSE(c, async (sseStream) => {
      const abort = new AbortController();
      const keepAlive = setInterval(() => {
        void sseStream.write(SSE_KEEPALIVE);
      }, KEEPALIVE_INTERVAL_MS);

      sseStream.onAbort(() => {
        clearInterval(keepAlive);
        abort.abort();
      });

      try {
        for await (const event of ai.assist(request, {
          actor: c.var.principal.user,
          datasourceId,
          dialect,
          signal: abort.signal,
        })) {
          await sseStream.write(encodeAiSseEvent(event));
          if (event.type === 'done' || event.type === 'error') {
            break;
          }
        }
      } finally {
        clearInterval(keepAlive);
      }
    });
  });

  return app;
}
