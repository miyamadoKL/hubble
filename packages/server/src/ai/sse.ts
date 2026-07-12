/**
 * LLM provider の SSE レスポンスを逐次パースする共通ヘルパー。
 *
 * Gemini API や GitHub Models など、HTTP レスポンスボディが SSE 形式で
 * 返る provider 実装から利用する。空行区切りでイベントを分割し、
 * `data:` 行のペイロードを連結して yield する。
 */
import { AppError } from '../errors';

const DEFAULT_MAX_EVENT_BYTES = 1_048_576;
const DEFAULT_MAX_STREAM_BYTES = 4_194_304;

/** provider SSE の受信サイズ制限。 */
export interface SseParseLimits {
  /** 空行で区切られた単一イベントの最大 byte 数。 */
  maxEventBytes?: number;
  /** ストリーム全体で受信する最大 byte 数。 */
  maxStreamBytes?: number;
}

/**
 * ReadableStream から SSE の `data:` ペイロード文字列を順に yield する。
 *
 * @param body - provider が返した SSE レスポンスボディ。
 * @param limits - 単一イベントとストリーム全体の受信サイズ制限。
 * @yields 各 SSE イベントの data ペイロード（複数行の場合は改行で連結）。
 */
export async function* parseSseDataLines(
  body: ReadableStream<Uint8Array>,
  limits: SseParseLimits = {},
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const maxEventBytes = limits.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
  const maxStreamBytes = limits.maxStreamBytes ?? DEFAULT_MAX_STREAM_BYTES;
  let buffer = '';
  let bufferBytes = 0;
  let pendingCarriageReturn = false;
  let streamBytes = 0;
  let reachedEof = false;

  /** チャンク境界をまたぐ CRLF を含め、受信した改行を LF にそろえる。 */
  const appendNormalized = (chunk: string): void => {
    let source = pendingCarriageReturn ? `\r${chunk}` : chunk;
    pendingCarriageReturn = source.endsWith('\r');
    if (pendingCarriageReturn) {
      source = source.slice(0, -1);
    }
    const normalized = source.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
    buffer += normalized;
    bufferBytes += encoder.encode(normalized).byteLength;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        reachedEof = true;
        break;
      }
      streamBytes += value.byteLength;
      if (streamBytes > maxStreamBytes) {
        throw invalidResponse('AI provider SSE stream exceeded the maximum size');
      }
      appendNormalized(decoder.decode(value, { stream: true }));

      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        const blockBytes = encoder.encode(block).byteLength;
        assertEventSize(blockBytes, maxEventBytes);
        buffer = buffer.slice(boundary + 2);
        bufferBytes -= blockBytes + 2;
        const payload = extractDataPayload(block);
        if (payload !== undefined) {
          yield payload;
        }
        boundary = buffer.indexOf('\n\n');
      }
      assertEventSize(bufferBytes, maxEventBytes);
    }

    appendNormalized(decoder.decode());
    if (pendingCarriageReturn) {
      buffer += '\n';
      bufferBytes += 1;
      pendingCarriageReturn = false;
    }

    if (buffer.trim() !== '') {
      assertEventSize(bufferBytes, maxEventBytes);
      const payload = extractDataPayload(buffer);
      if (payload !== undefined) {
        yield payload;
      }
    }
  } finally {
    if (!reachedEof) {
      // サイズ超過や利用側の早期終了では、cancel 失敗より元の結果を優先する。
      try {
        void reader.cancel().catch(() => undefined);
      } catch {
        // cancel の同期例外も元の結果を上書きさせない。
      }
    }
    reader.releaseLock();
  }
}

/** 正規化済みイベントが byte 上限を超えていないことを確認する。 */
function assertEventSize(eventBytes: number, maxEventBytes: number): void {
  if (eventBytes > maxEventBytes) {
    throw invalidResponse('AI provider SSE event exceeded the maximum size');
  }
}

/** provider の応答契約違反を API 共通のエラーへ変換する。 */
export function invalidResponse(message: string): AppError {
  return new AppError(502, { code: 'INVALID_RESPONSE', message });
}

/** SSE イベントブロックから `data:` 行の内容を連結して取り出す。 */
function extractDataPayload(block: string): string | undefined {
  const lines = block.split('\n');
  const dataParts: string[] = [];
  for (const line of lines) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('data:')) {
      dataParts.push(line.slice('data:'.length).trimStart());
    }
  }
  if (dataParts.length === 0) return undefined;
  return dataParts.join('\n');
}
