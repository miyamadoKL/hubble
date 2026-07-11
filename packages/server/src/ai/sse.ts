/**
 * LLM provider の SSE レスポンスを逐次パースする共通ヘルパー。
 *
 * Gemini API や GitHub Models など、HTTP レスポンスボディが SSE 形式で
 * 返る provider 実装から利用する。空行区切りでイベントを分割し、
 * `data:` 行のペイロードを連結して yield する。
 */

/**
 * ReadableStream から SSE の `data:` ペイロード文字列を順に yield する。
 *
 * @param body - provider が返した SSE レスポンスボディ。
 * @yields 各 SSE イベントの data ペイロード（複数行の場合は改行で連結）。
 */
export async function* parseSseDataLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let pendingCarriageReturn = false;

  /** チャンク境界をまたぐ CRLF を含め、受信した改行を LF にそろえる。 */
  const appendNormalized = (chunk: string): void => {
    let source = pendingCarriageReturn ? `\r${chunk}` : chunk;
    pendingCarriageReturn = source.endsWith('\r');
    if (pendingCarriageReturn) {
      source = source.slice(0, -1);
    }
    buffer += source.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      appendNormalized(decoder.decode(value, { stream: true }));

      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const payload = extractDataPayload(block);
        if (payload !== undefined) {
          yield payload;
        }
        boundary = buffer.indexOf('\n\n');
      }
    }

    appendNormalized(decoder.decode());
    if (pendingCarriageReturn) {
      buffer += '\n';
      pendingCarriageReturn = false;
    }

    if (buffer.trim() !== '') {
      const payload = extractDataPayload(buffer);
      if (payload !== undefined) {
        yield payload;
      }
    }
  } finally {
    reader.releaseLock();
  }
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
