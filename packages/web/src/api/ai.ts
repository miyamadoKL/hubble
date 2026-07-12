/**
 * AI アシスタント API クライアント。
 *
 * `POST /api/ai/assist` は SSE ストリームを返すため、他のエンドポイントで使う
 * `apiFetch`（JSON 一括取得）は使えない。このファイルでは fetch + ReadableStream で
 * SSE フレームを逐次パースし、contracts の `aiAssistEventSchema` で検証した
 * 型付きイベントをハンドラへ渡すストリーミングクライアントを提供する。
 */
import {
  aiAssistEventSchema,
  apiErrorSchema,
  apiRoutes,
  type AiAssistEvent,
  type AiAssistRequest,
  type ApiErrorDetail,
} from '@hubble/contracts';
import { ApiClientError } from './client';

const MAX_SSE_EVENT_BYTES = 1_048_576;
const MAX_SSE_STREAM_BYTES = 4_194_304;

/** ストリーミング呼び出しのハンドラ群。 */
export interface AiAssistHandlers {
  /** 検証済みイベント（delta / done / error）を受け取る。 */
  onEvent: (event: AiAssistEvent) => void;
}

/** `streamAiAssist` のオプション。 */
export interface AiAssistOptions {
  /** 呼び出しを中断するためのシグナル（停止ボタン用）。 */
  signal?: AbortSignal;
  /** fetch の差し替え（テスト用）。 */
  fetchImpl?: typeof fetch;
}

/**
 * SSE レスポンスボディを 1 フレームずつパースして data ペイロード文字列を yield する。
 * フレームは空行（\n\n）区切り、`data:` 行の連結、`:` コメント行（keep-alive）の
 * 無視という SSE の基本仕様に対応する。
 */
async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  let bufferBytes = 0;
  let pendingCarriageReturn = false;
  let streamBytes = 0;
  let reachedEof = false;

  /** チャンク境界をまたぐ CRLF を含め、改行を LF にそろえる。 */
  const appendNormalized = (chunk: string): void => {
    let source = pendingCarriageReturn ? `\r${chunk}` : chunk;
    pendingCarriageReturn = source.endsWith('\r');
    if (pendingCarriageReturn) source = source.slice(0, -1);
    const normalized = source.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
    buffer += normalized;
    bufferBytes += encoder.encode(normalized).byteLength;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        reachedEof = true;
        break;
      }
      streamBytes += value.byteLength;
      if (streamBytes > MAX_SSE_STREAM_BYTES) {
        throw invalidStreamingResponse('AI assistant stream exceeded the maximum size');
      }
      appendNormalized(decoder.decode(value, { stream: true }));
      // 空行区切りでフレームを取り出す（末尾の未完フレームは buffer に残す）。
      let sep = buffer.indexOf('\n\n');
      while (sep >= 0) {
        const frame = buffer.slice(0, sep);
        const frameBytes = encoder.encode(frame).byteLength;
        assertFrameSize(frameBytes);
        buffer = buffer.slice(sep + 2);
        bufferBytes -= frameBytes + 2;
        const data = frameData(frame);
        if (data !== undefined) yield data;
        sep = buffer.indexOf('\n\n');
      }
      assertFrameSize(bufferBytes);
    }

    appendNormalized(decoder.decode());
    if (pendingCarriageReturn) {
      buffer += '\n';
      bufferBytes += 1;
      pendingCarriageReturn = false;
    }
    if (buffer.trim() !== '') assertFrameSize(bufferBytes);
  } finally {
    if (!reachedEof) {
      // 契約違反や利用側の早期終了では、cancel 失敗より元の結果を優先する。
      try {
        void reader.cancel().catch(() => undefined);
      } catch {
        // cancel の同期例外も元の結果を上書きさせない。
      }
    }
    reader.releaseLock();
  }
}

/** 単一 SSE フレームの byte 上限を検証する。 */
function assertFrameSize(frameBytes: number): void {
  if (frameBytes > MAX_SSE_EVENT_BYTES) {
    throw invalidStreamingResponse('AI assistant SSE event exceeded the maximum size');
  }
}

/** AI SSE の契約違反を統一したクライアントエラーにする。 */
function invalidStreamingResponse(message: string): ApiClientError {
  return new ApiClientError(200, { code: 'INVALID_RESPONSE', message });
}

/** SSE フレームから `data:` 行を連結して返す。data 行が無ければ undefined。 */
function frameData(frame: string): string | undefined {
  const parts: string[] = [];
  for (const line of frame.split('\n')) {
    // `:` で始まる行はコメント（keep-alive）なので無視する。
    if (line.startsWith(':')) continue;
    if (line.startsWith('data:')) {
      // SSE 仕様では `data:` 直後の空白 1 つを取り除く。
      parts.push(line.slice(5).replace(/^ /, ''));
    }
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}

/**
 * `POST /api/ai/assist` を呼び出し、SSE イベントを逐次ハンドラへ渡す。
 * done または error イベントの受信、abort のいずれかで解決する。
 * 終端イベントのない EOF は契約違反として拒否する。
 *
 * HTTP エラー（403 / 501 / 400 など、ストリーム開始前の失敗）は
 * `ApiClientError` として throw する。ストリーム開始後のエラーは
 * `error` イベントとしてハンドラに渡される。
 *
 * @param request - 契約 `AiAssistRequest`（タスク種別と文脈）。
 * @param handlers - イベント受信ハンドラ。
 * @param options - abort シグナルと fetch 差し替え。
 */
export async function streamAiAssist(
  request: AiAssistRequest,
  handlers: AiAssistHandlers,
  options: AiAssistOptions = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const res = await fetchImpl(apiRoutes.aiAssist(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
    signal: options.signal,
  });

  if (!res.ok) {
    // ストリーム開始前の失敗はエラーエンベロープをパースして throw する。
    let detail: ApiErrorDetail = {
      code: 'HTTP_ERROR',
      message: `Request failed with status ${res.status}`,
    };
    try {
      const parsed = apiErrorSchema.safeParse(await res.json());
      if (parsed.success) detail = parsed.data.error;
    } catch {
      // JSON でないボディはフォールバックの合成エラーのままにする。
    }
    throw new ApiClientError(res.status, detail);
  }

  if (!res.body) {
    throw new ApiClientError(res.status, {
      code: 'INVALID_RESPONSE',
      message: 'Streaming response has no body',
    });
  }

  for await (const data of parseSseStream(res.body)) {
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      continue; // 壊れたフレームは黙って無視する（クエリ SSE と同じ方針）。
    }
    const parsed = aiAssistEventSchema.safeParse(payload);
    if (!parsed.success) continue;
    handlers.onEvent(parsed.data);
    // done / error が届いたらストリームは完結扱いにする。
    if (parsed.data.type === 'done' || parsed.data.type === 'error') return;
  }
  throw invalidStreamingResponse('AI assistant stream ended without a terminal event');
}
