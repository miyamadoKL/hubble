// AI providerから受信するSSEの改行形式、チャンク境界とdata連結を検証する。
import { describe, expect, it } from 'vitest';

import { parseSseDataLines } from './sse';

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

async function collect(chunks: string[]): Promise<string[]> {
  const payloads: string[] = [];
  for await (const payload of parseSseDataLines(streamFromChunks(chunks))) {
    payloads.push(payload);
  }
  return payloads;
}

describe('parseSseDataLines', () => {
  it.each([
    ['LF', ['data: first\n\ndata: second\n\n']],
    ['CRLF', ['data: first\r\n\r\ndata: second\r\n\r\n']],
    ['CR', ['data: first\r\rdata: second\r\r']],
  ])('%s の空行でイベントを分割する', async (_name, chunks) => {
    await expect(collect(chunks)).resolves.toEqual(['first', 'second']);
  });

  it('CRLF がチャンク境界をまたいでもイベントを分割する', async () => {
    await expect(
      collect(['data: first\r', '\n\r', '\ndata: second\r\n', '\r', '\n']),
    ).resolves.toEqual(['first', 'second']);
  });

  it('複数の data 行を改行で連結し、コメントと他フィールドを無視する', async () => {
    await expect(
      collect([': keep-alive\r\nevent: message\r\ndata: first\r\ndata: second\r\n\r\n']),
    ).resolves.toEqual(['first\nsecond']);
  });

  it('イベント終端前にストリームが終わっても受信済みの data を返す', async () => {
    await expect(collect(['data: partial\r\ndata: response'])).resolves.toEqual([
      'partial\nresponse',
    ]);
  });
});
